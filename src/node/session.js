'use strict';

// One client connection, from raw bytes to an established tunnel.
//
// Lifecycle: HTTP request head -> WebSocket upgrade -> VLESS header -> one of
// three relays (relay.js / udp.js / mux.js), after which every message is
// opaque payload handed to that relay.
//
// ---------------------------------------------------------------------------
// The contract relay modules code against. They receive a Session and touch
// only these; they must never require() this module back.
//
//   session.config   session.log   session.stats   session.connInfo   session.dns
//   session.dead                     -- getter; NEVER destructure it (see below)
//
// `connInfo` is null until the VLESS header validates -- decoy hits, the health
// check on GET /, the dashboard and the stats stream never allocate one. Relays
// are only ever constructed after that point, so a relay never observes null.
//
//   session.sendWs(opcode, payload)  -- false on backpressure
//   session.sendMux(meta, hasData, payload)
//   session.pauseSource(stream)      -- registers stream for resume on client drain
//   session.pauseClient() / session.resumeClient()
//   session.destroy(reason)
//
// `dead` is a getter over a private field on purpose: a captured
// `const dead = session.dead` would freeze at false and let a torn-down
// session keep writing to closed sockets.
// ---------------------------------------------------------------------------

const {
  ByteQueue, VLESS_OK_HEADER, parseVlessHeader
} = require('../vless.js');

const { OPCODE, decodeFrame, encodeFrame, encodeMuxFrame } = require('./wsframe.js');
const {
  indexOfHeaderEnd, parseRequestHead, sendHttpResponse, writeUpgradeResponse,
  sendEventStreamHead, sendSseRetry, sendSseComment, sendSseEvent
} = require('./http.js');
const { FAKE_INDEX_HTML, renderStatsPage } = require('./pages.js');
const { createTcpRelay } = require('./relay.js');
const { createUdpRelay } = require('./udp.js');
const { createMuxSession } = require('./mux.js');

const HTML = 'text/html; charset=utf-8';

const STATE_HTTP = 'HTTP';
const STATE_WS = 'WS';
const STATE_SSE = 'SSE';

const ADMIN_PATH = '/admin-stats';
const ADMIN_STREAM_PATH = '/admin-stats/stream';

// One snapshot per second. The uptime counter advancing is also the cheapest
// possible "this page is live" signal, and 1 Hz is far inside every proxy idle
// timeout worth worrying about (Fly's is ~60s). If this is ever raised past
// ~20s, a periodic `: ping` comment becomes necessary — without one the stream
// dies each minute and EventSource silently reconnects, which looks like a
// flickering dashboard rather than a timeout.
const SSE_INTERVAL_MS = 1000;

// Still draining from the last tick: skip this snapshot rather than queue it.
const SSE_SKIP_BYTES = 64 * 1024;

// Genuinely stuck (a suspended tab whose socket never FINs): give up.
const SSE_MAX_BUFFERED = 1024 * 1024;

class Session {
  #client;
  #state = STATE_HTTP;
  #dead = false;

  // Raw bytes off the socket: HTTP head first, then WebSocket frames.
  #inbound = new ByteQueue();
  // Reassembly buffer for fragmented WebSocket messages, and for a VLESS
  // header that has not arrived in full yet.
  #message = new ByteQueue();

  #relay = null;
  #vlessStarted = false;
  #sseTimer = null;

  // Sources paused because the client could not keep up. The single 'drain'
  // handler resumes everything here, so no relay needs to see that event.
  #paused = new Set();

  constructor(client, deps) {
    this.#client = client;
    this.config = deps.config;
    this.stats = deps.stats;
    this.dns = deps.dns;
    this.log = deps.log;
    // Allocated only once a VLESS header validates — see #onMessage().
    this.connInfo = null;
  }

  get dead() {
    return this.#dead;
  }

  start() {
    const client = this.#client;
    client.on('data', (chunk) => this.#onData(chunk));
    client.on('error', (err) => this.destroy('Client Error: ' + err));
    client.on('close', () => this.destroy('Client Closed'));
    client.on('drain', () => this.#onDrain());
    return this;
  }

  // ----- the relay-facing surface -----

  sendWs(opcode, payload) {
    if (this.#dead) return true;
    return this.#client.write(encodeFrame(opcode, payload));
  }

  sendMux(meta, hasData, payload) {
    if (this.#dead || this.#client.destroyed) return true;
    return this.#client.write(encodeMuxFrame(OPCODE.BINARY, meta, hasData, payload));
  }

  pauseSource(stream) {
    if (!stream) return;
    stream.pause();
    this.#paused.add(stream);
  }

  pauseClient() {
    this.#client.pause();
  }

  resumeClient() {
    if (!this.#dead) this.#client.resume();
  }

  #onDrain() {
    if (this.#dead) return;
    for (const stream of this.#paused) {
      try { stream.resume(); } catch (e) { /* already gone */ }
    }
    this.#paused.clear();
  }

  destroy(reason) {
    if (this.#dead) return;
    this.#dead = true;

    if (this.#sseTimer) {
      clearInterval(this.#sseTimer);
      this.#sseTimer = null;
    }

    const client = this.#client;
    client.removeAllListeners('data');
    client.removeAllListeners('drain');
    client.removeAllListeners('error');
    client.removeAllListeners('close');
    try { client.destroy(); } catch (e) { /* already gone */ }

    if (this.#relay) {
      try { this.#relay.close(); } catch (e) { /* already gone */ }
      this.#relay = null;
    }

    this.#paused.clear();
    this.#inbound.clear();
    this.#message.clear();

    this.stats.closeConnection(this.connInfo);
    void reason;
  }

  // ----- byte pump -----

  #onData(chunk) {
    if (this.#dead) return;

    // A stats stream is write-only from here on. Returning before the push also
    // means a client that pipelines garbage down it cannot grow the queue.
    if (this.#state === STATE_SSE) return;

    this.#inbound.push(chunk);

    if (this.#state === STATE_HTTP) this.#handleHttp();
    if (this.#dead) return;
    if (this.#state === STATE_WS) this.#handleWs();
  }

  /**
   * Consume the request head and dispatch.
   *
   * Deliberately returns nothing: `#state` is the source of truth, and a
   * boolean cannot express the three real outcomes (upgraded, handled and
   * closed, handled and still streaming). Every terminal path below either
   * sets `#dead` or moves `#state`.
   */
  #handleHttp() {
    const head = this.#inbound.flatten();
    const eoh = indexOfHeaderEnd(head);

    if (eoh === -1) {
      // Nothing to parse yet. Cap the buffer so a client that connects and
      // never sends \r\n\r\n cannot grow it without bound.
      if (this.#inbound.size > this.config.maxHeaderBytes) {
        this.destroy('Request head too large');
      }
      return;
    }

    const req = parseRequestHead(head.subarray(0, eoh + 4));
    this.#inbound.consume(eoh + 4);

    if (!req) {
      this.destroy('Invalid HTTP');
      return;
    }

    if (req.basePath === ADMIN_PATH) return this.#serveAdminStats(req);
    if (req.basePath === ADMIN_STREAM_PATH) return this.#serveAdminStream(req);

    const upgrade = req.headers.upgrade;
    if (req.method !== 'GET' || !upgrade || upgrade.toLowerCase() !== 'websocket') {
      return this.#serveDecoy(200, 'Not WS Request - served fake page');
    }

    if (!req.path.includes(this.config.wsPath)) {
      return this.#serveDecoy(200, 'Bad WS Path - served fake page');
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
      return this.#serveDecoy(400, 'No WS Key - served fake page');
    }

    writeUpgradeResponse(this.#client, key);
    this.#state = STATE_WS;
  }

  #serveDecoy(status, reason) {
    sendHttpResponse(this.#client, status, HTML, FAKE_INDEX_HTML);
    this.destroy(reason);
  }

  /**
   * The gate for both admin routes. Shared so the two cannot drift apart —
   * a stream that authorised more loosely than the page would be a silent hole.
   */
  #adminAuthorised(req) {
    if (req.method !== 'GET') return false;
    if (!this.config.adminToken) return false;
    const token = req.query ? new URLSearchParams(req.query).get('token') : null;
    return tokensMatch(token, this.config.adminToken);
  }

  #serveAdminStats(req) {
    if (!this.#adminAuthorised(req)) {
      // Unset token or mismatch: hide the endpoint behind the decoy page so its
      // existence — and the wsPath it prints — is not disclosed.
      return this.#serveDecoy(200, 'Admin stats gated - served fake page');
    }

    sendHttpResponse(this.#client, 200, HTML,
      renderStatsPage(this.stats.snapshot(), this.config.wsPath));
    this.destroy('Admin stats served');
  }

  /**
   * The live stats stream behind the dashboard.
   *
   * Unauthorised requests get byte-identical bytes to an unauthorised
   * /admin-stats, which are byte-identical to GET / — probing this path
   * discloses nothing that probing the root does not.
   */
  #serveAdminStream(req) {
    if (!this.#adminAuthorised(req)) {
      return this.#serveDecoy(200, 'Admin stream gated - served fake page');
    }

    if (!sendEventStreamHead(this.#client)) {
      return this.destroy('SSE head write failed');
    }

    this.#state = STATE_SSE;
    // A suspended laptop leaves a half-open socket that never signals close;
    // TCP keepalive is the only thing that detects it.
    this.#client.setKeepAlive(true, 30000);

    sendSseRetry(this.#client, 3000);
    sendSseComment(this.#client, 'ok');

    this.#pushStats();   // first paint, rather than a blank second
    this.#sseTimer = setInterval(() => this.#pushStats(), SSE_INTERVAL_MS);
    // Never let this timer be the reason the process stays alive; the open
    // socket already refs the loop, and a stray interval would hang `--test`.
    this.#sseTimer.unref();
  }

  /**
   * Push one snapshot.
   *
   * Every event is a whole snapshot, never a delta — which is what makes
   * dropping a tick free: the next one is authoritative, so a slow client costs
   * resolution rather than correctness. It is also why no `id:` is emitted and
   * no replay buffer exists.
   */
  #pushStats() {
    if (this.#dead) return;
    const client = this.#client;

    if (client.writableLength > SSE_MAX_BUFFERED) {
      return this.destroy('SSE client stalled');
    }
    if (client.writableLength > SSE_SKIP_BYTES) return;

    sendSseEvent(client, JSON.stringify(this.stats.snapshot()));
  }

  // ----- WebSocket framing -----

  #handleWs() {
    for (;;) {
      if (this.#dead) return;

      const buf = this.#inbound.flatten();
      if (buf.length === 0) return;

      const frame = decodeFrame(buf);
      if (!frame) return;
      this.#inbound.consume(frame.consumed);

      if (frame.opcode === OPCODE.CLOSE) {
        return this.destroy('Client Triggered WS Close');
      }

      if (frame.opcode === OPCODE.PING) {
        this.sendWs(OPCODE.PONG, frame.payload);
        continue;
      }

      if (frame.opcode !== OPCODE.CONT &&
          frame.opcode !== OPCODE.TEXT &&
          frame.opcode !== OPCODE.BINARY) {
        continue;
      }

      // Reassemble fragmented messages: only a FIN frame completes one.
      let message = null;
      if (frame.opcode === OPCODE.CONT) {
        this.#message.push(frame.payload);
        if (frame.fin) {
          message = this.#message.flatten();
          this.#message.clear();
        }
      } else if (frame.fin) {
        message = frame.payload;
      } else {
        this.#message.push(frame.payload);
      }

      if (message) this.#onMessage(message);
    }
  }

  #onMessage(message) {
    if (this.#vlessStarted) {
      if (this.#relay) this.#relay.write(message);
      return;
    }

    // The VLESS header may span several messages; keep accumulating until the
    // parser has enough to decide.
    this.#message.push(message);
    const buf = this.#message.flatten();
    const result = parseVlessHeader(buf, this.config.uuidBytes);

    if (result.status === 'need') return;

    if (result.status === 'fail') {
      this.#message.clear();
      this.#serveDecoy(200, 'vls Auth Failed -> ' + result.reason);
      return;
    }

    this.#vlessStarted = true;

    // Only a validated tunnel is counted. Decoy hits, the platform health check
    // on GET /, dashboard loads and the stats stream must not inflate
    // totalConnections or push rows into the history table — the dashboard used
    // to pollute its own data at ~12 rows a minute. Must happen before any
    // relay is constructed: relays read session.connInfo synchronously.
    this.connInfo = this.stats.openConnection();

    const initial = buf.slice(result.headerEnd);
    this.#message.clear();

    this.sendWs(OPCODE.BINARY, VLESS_OK_HEADER);

    if (result.cmd === 1) {
      this.#relay = createTcpRelay(this, result.host, result.port, initial);
    } else if (result.cmd === 2) {
      this.#relay = createUdpRelay(this, result.host, result.port, initial);
    } else if (result.cmd === 3) {
      this.#relay = createMuxSession(this, initial);
    }
  }
}

/**
 * Constant-time token comparison.
 *
 * A plain `===` on strings short-circuits at the first differing character,
 * which leaks the admin token one byte at a time to anyone who can time the
 * response.
 */
function tokensMatch(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return require('crypto').timingSafeEqual(a, b);
}

function handleConnection(client, deps) {
  return new Session(client, deps).start();
}

module.exports = { Session, handleConnection, tokensMatch };
