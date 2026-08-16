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
  indexOfHeaderEnd, parseRequestHead, sendHttpResponse, writeUpgradeResponse
} = require('./http.js');
const { FAKE_INDEX_HTML, renderStatsPage } = require('./pages.js');
const { createTcpRelay } = require('./relay.js');
const { createUdpRelay } = require('./udp.js');
const { createMuxSession } = require('./mux.js');

const HTML = 'text/html; charset=utf-8';

const STATE_HTTP = 'HTTP';
const STATE_WS = 'WS';

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

  // Sources paused because the client could not keep up. The single 'drain'
  // handler resumes everything here, so no relay needs to see that event.
  #paused = new Set();

  constructor(client, deps) {
    this.#client = client;
    this.config = deps.config;
    this.stats = deps.stats;
    this.dns = deps.dns;
    this.log = deps.log;
    this.connInfo = deps.stats.openConnection();
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
    this.#inbound.push(chunk);

    if (this.#state === STATE_HTTP && !this.#handleHttp()) return;
    if (this.#state === STATE_WS) this.#handleWs();
  }

  /** Returns true once the connection has been upgraded to WebSocket. */
  #handleHttp() {
    const head = this.#inbound.flatten();
    const eoh = indexOfHeaderEnd(head);

    if (eoh === -1) {
      // Nothing to parse yet. Cap the buffer so a client that connects and
      // never sends \r\n\r\n cannot grow it without bound.
      if (this.#inbound.size > this.config.maxHeaderBytes) {
        this.destroy('Request head too large');
      }
      return false;
    }

    const req = parseRequestHead(head.subarray(0, eoh + 4));
    this.#inbound.consume(eoh + 4);

    if (!req) {
      this.destroy('Invalid HTTP');
      return false;
    }

    if (req.method === 'GET' && req.basePath === '/admin-stats') {
      this.#serveAdminStats(req);
      return false;
    }

    const upgrade = req.headers.upgrade;
    if (req.method !== 'GET' || !upgrade || upgrade.toLowerCase() !== 'websocket') {
      this.#serveDecoy(200, 'Not WS Request - served fake page');
      return false;
    }

    if (!req.path.includes(this.config.wsPath)) {
      this.#serveDecoy(200, 'Bad WS Path - served fake page');
      return false;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
      this.#serveDecoy(400, 'No WS Key - served fake page');
      return false;
    }

    writeUpgradeResponse(this.#client, key);
    this.#state = STATE_WS;
    return true;
  }

  #serveDecoy(status, reason) {
    sendHttpResponse(this.#client, status, HTML, FAKE_INDEX_HTML);
    this.destroy(reason);
  }

  #serveAdminStats(req) {
    const token = req.query ? new URLSearchParams(req.query).get('token') : null;

    if (this.config.adminToken && tokensMatch(token, this.config.adminToken)) {
      sendHttpResponse(this.#client, 200, HTML,
        renderStatsPage(this.stats.snapshot(), this.config.wsPath));
      this.destroy('Admin stats served');
      return;
    }

    // Unset token or mismatch: hide the endpoint behind the decoy page so its
    // existence — and the wsPath it prints — is not disclosed.
    this.#serveDecoy(200, 'Admin stats gated - served fake page');
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
