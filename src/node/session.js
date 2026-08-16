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
  indexOfHeaderEnd, parseRequestHead, parseCookies, sendHttpResponse, sendRedirect,
  writeUpgradeResponse, sendEventStreamHead, sendSseRetry, sendSseComment, sendSseEvent
} = require('./http.js');
const {
  tokensMatch, mintSession, verifySession, mintInvite, verifyInvite
} = require('./tokens.js');
const { randomBytes } = require('crypto');
const { clientIp } = require('./ratelimit.js');
const { FAKE_INDEX_HTML, renderStatsPage, renderAdminNav } = require('./pages.js');
const {
  renderProvisionPage, renderInvitePage, renderRevealPage, renderStalePage
} = require('./provision-pages.js');
const { buildVlessLink, buildXrayConfig } = require('./clientconf.js');
const { createTcpRelay } = require('./relay.js');
const { createUdpRelay } = require('./udp.js');
const { createMuxSession } = require('./mux.js');

const HTML = 'text/html; charset=utf-8';

const STATE_HTTP = 'HTTP';
const STATE_WS = 'WS';
const STATE_SSE = 'SSE';

const ADMIN_PATH = '/admin-stats';
const ADMIN_STREAM_PATH = '/admin-stats/stream';
const ADMIN_PROVISION_PATH = '/admin-stats/provision';

const JSON_TYPE = 'application/json; charset=utf-8';

// How long a redeemed invite keeps working, so a reflexive pull-to-refresh on a
// phone does not lose the config for good.
const INVITE_GRACE_MS = 5 * 60 * 1000;

// Only ever used to name a downloaded file and to label a profile.
const SAFE_LABEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;

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
    this.deps = deps;
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
    if (req.basePath === ADMIN_PROVISION_PATH) return this.#serveProvision(req);

    const upgrade = req.headers.upgrade;
    const upgrading = Boolean(upgrade) && upgrade.toLowerCase() === 'websocket';

    // Invite paths carry a variable segment, so this is the one prefix match in
    // the router. The !upgrading guard is load-bearing: the WebSocket path is
    // matched by substring, so a WSPATH containing the invite prefix would
    // otherwise have every real tunnel swallowed and served the decoy — silently,
    // with no log line. server.js warns at boot if the two can collide.
    if (!upgrading && this.config.provisioning &&
        req.basePath.startsWith(this.config.invitePath)) {
      return this.#serveInvite(req);
    }

    if (req.method !== 'GET' || !upgrading) {
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
   * Is this connection carrying TLS end-to-end?
   *
   * Fly terminates TLS at its proxy, so on Fly the socket is plaintext and
   * X-Forwarded-Proto is the only signal — trusted only when we know we are
   * behind that proxy. Locally over http:// a Secure cookie cannot be set at
   * all, which is why the cookie name differs by scheme.
   */
  #isSecure(req) {
    if (this.#client.encrypted) return true;
    if (!this.config.trustProxy) return false;
    const proto = req.headers['x-forwarded-proto'];
    return Boolean(proto) && proto.split(',')[0].trim() === 'https';
  }

  #cookieName(req) {
    // __Host- is browser-ENFORCED (Secure, Path=/, no Domain), so a sibling
    // subdomain cannot plant it. It is only legal on a secure origin.
    return this.#isSecure(req) ? '__Host-adm' : 'adm';
  }

  /**
   * The gate for every admin route. Shared so they cannot drift apart — a
   * stream that authorised more loosely than the page would be a silent hole.
   *
   * Tri-state so the caller knows whether to upgrade a query bootstrap into a
   * cookie: 'cookie' | 'query' | null.
   */
  #adminAuth(req) {
    if (req.method !== 'GET') return null;
    if (!this.config.adminToken) return null;

    // Only ever accept the cookie name that matches this connection's scheme,
    // or a downgrade attacker could plant the plain name and have it honoured
    // over TLS.
    const jar = parseCookies(req.headers.cookie);
    if (verifySession(this.config.sessionKey, jar[this.#cookieName(req)])) return 'cookie';

    const token = req.query ? new URLSearchParams(req.query).get('token') : null;
    return tokensMatch(token, this.config.adminToken) ? 'query' : null;
  }

  #adminAuthorised(req) {
    return this.#adminAuth(req) !== null;
  }

  /**
   * The nav shared by the dashboard and the provisioning page.
   *
   * The provision entry is gated on exactly the condition #serveProvision gates
   * on, so the link can never lead to the decoy — which would read as a broken
   * site rather than a feature that is switched off.
   */
  #adminNav(current) {
    return renderAdminNav({
      current,
      statsPath: ADMIN_PATH,
      provisionPath: this.config.provisioning ? ADMIN_PROVISION_PATH : null,
      logoutPath: ADMIN_PATH + '?logout=1'
    });
  }

  /**
   * Charge a failed attempt against the caller's budget.
   *
   * Over the limit still serves the decoy rather than a 429: a distinct status
   * would make the endpoint tellable apart from `GET /`, which is the whole
   * property these routes are built around.
   *
   * The log line is charged to the same bucket, so a probe flood cannot fill
   * the platform's log budget either.
   */
  #noteFailure(req, kind) {
    const limits = this.deps.limits;
    if (!limits) return;
    const ip = clientIp(req, this.#client, this.config);
    if (limits.adminFail.allow(`${kind}:${ip}`)) {
      this.log('AUTH-FAIL', `${kind} rejected for ${ip}`);
    }
  }

  #setCookieLine(req, value, maxAge) {
    const attrs = `Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict`;
    return this.#isSecure(req)
      ? `Set-Cookie: __Host-adm=${value}; ${attrs}; Secure`
      : `Set-Cookie: adm=${value}; ${attrs}`;
  }

  /**
   * Rebuild this request's URL without the token.
   *
   * basePath is a compile-time constant on every branch that calls this (the
   * dispatch is exact-equality), and URLSearchParams percent-encodes, so the
   * Location is fully server-controlled and CRLF injection into it is
   * structurally impossible.
   */
  #cleanUrl(req) {
    const params = new URLSearchParams(req.query || '');
    params.delete('token');
    const rest = params.toString();
    return rest ? `${req.basePath}?${rest}` : req.basePath;
  }

  /**
   * Trade a ?token= bootstrap for a session cookie and redirect to a clean URL.
   *
   * This is what keeps the credential out of browser history, bookmarks and the
   * Referer sent to the CDN. The cookie carries a signed, expiring assertion
   * rather than the token itself, so one lifted from a device backup cannot be
   * replayed as ?token=.
   */
  #exchangeForCookie(req) {
    const value = mintSession(this.config.sessionKey, this.config.sessionTtl);
    sendRedirect(this.#client, this.#cleanUrl(req),
      [this.#setCookieLine(req, value, this.config.sessionTtl)]);
    this.destroy('Admin session established');
  }

  #serveAdminStats(req) {
    const auth = this.#adminAuth(req);
    if (!auth) {
      // Unset token or mismatch: hide the endpoint behind the decoy page so its
      // existence — and the wsPath it prints — is not disclosed.
      this.#noteFailure(req, 'admin');
      return this.#serveDecoy(200, 'Admin stats gated - served fake page');
    }

    // Explicit sign-out, the only way to drop a session from a shared device.
    if (req.query && new URLSearchParams(req.query).get('logout') === '1') {
      sendRedirect(this.#client, req.basePath, [this.#setCookieLine(req, '', 0)]);
      return this.destroy('Admin session cleared');
    }

    if (auth === 'query') return this.#exchangeForCookie(req);

    sendHttpResponse(this.#client, 200, HTML,
      renderStatsPage(this.stats.snapshot(), this.config.wsPath, this.#adminNav('stats')));
    this.destroy('Admin stats served');
  }

  // ----- provisioning -----

  /** The public origin generated configs should point at. */
  #publicHost(req) {
    if (this.config.publicHost) return this.config.publicHost;
    // Fall back to the Host header only when PUBLIC_HOST is unset, and only if
    // it is a plausible hostname — it is client-controlled, so a bad value must
    // produce no config rather than a config pointing somewhere unexpected.
    const raw = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
    return /^[a-z0-9.-]{1,253}$/.test(raw) ? raw : '';
  }

  #inviteUrl(req, token, suffix = '') {
    const host = req.headers.host || this.#publicHost(req);
    const scheme = this.#isSecure(req) ? 'https' : 'http';
    return `${scheme}://${host}${this.config.invitePath}${token}${suffix}`;
  }

  /** Operator page: pick a user, mint a short-lived invite. */
  #serveProvision(req) {
    const auth = this.#adminAuth(req);
    if (!auth || !this.config.provisioning) {
      if (!auth) this.#noteFailure(req, 'admin');
      return this.#serveDecoy(200, 'Provision gated - served fake page');
    }
    if (auth === 'query') return this.#exchangeForCookie(req);

    const params = new URLSearchParams(req.query || '');
    const label = params.get('label');

    let minted = null;
    const user = label ? this.config.registry.mintable(label) : null;
    if (label && !user) {
      // An unknown or reserved label is a probe or a stale form; say nothing.
      return this.#serveDecoy(200, 'Provision unknown label - served fake page');
    }

    if (user) {
      const nonce = randomBytes(6).toString('base64url');
      const { token, exp } = mintInvite(
        this.config.inviteKey, user.label, this.config.inviteTtl, nonce
      );
      minted = {
        label: user.label,
        url: this.#inviteUrl(req, token),
        expiresAt: new Date(exp * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
      };
      this.log('PROVISION', `Invite minted for ${user.label}, expires ${minted.expiresAt}`);
    }

    sendHttpResponse(this.#client, 200, HTML, renderProvisionPage({
      nav: this.#adminNav('provision'),
      labels: this.config.registry.labels,
      minted,
      publicHost: this.config.publicHost,
      adminPath: ADMIN_PROVISION_PATH
    }));
    this.destroy('Provision page served');
  }

  /**
   * Invitee routes: /i/<token>, /i/<token>/show and /i/<token>/conf.json.
   *
   * A bad signature is served the decoy — byte-identical to GET / — so probing
   * this prefix cannot reveal that provisioning exists. A VALID signature that
   * is merely expired gets a real page, because the signature proves the
   * operator minted it and telling that holder discloses nothing new.
   */
  #serveInvite(req) {
    const limits = this.deps.limits;
    if (limits) {
      const ip = clientIp(req, this.#client, this.config);
      // Per-caller, plus a global bucket so a distributed probe cannot flood
      // the decoy path either.
      if (!limits.invite.allow(ip) || !limits.global.allow('invite')) {
        return this.#serveDecoy(200, 'Invite rate limited - served fake page');
      }
    }

    const rest = req.basePath.slice(this.config.invitePath.length);
    const slash = rest.indexOf('/');
    const token = slash === -1 ? rest : rest.slice(0, slash);
    const action = slash === -1 ? '' : rest.slice(slash);

    if (action !== '' && action !== '/show' && action !== '/conf.json') {
      return this.#serveDecoy(200, 'Invite unknown action - served fake page');
    }

    const result = verifyInvite(this.config.inviteKey, token);
    if (result.reason === 'forged') {
      this.#noteFailure(req, 'invite');
      return this.#serveDecoy(200, 'Invite forged - served fake page');
    }

    const stale = () => {
      sendHttpResponse(this.#client, 200, HTML, renderStalePage());
      this.destroy('Invite stale');
    };

    if (!result.ok) return stale();

    // The landing page burns nothing: chat clients fetch a pasted URL to build
    // a preview, and burning here would kill the invite before the human taps.
    if (action === '') {
      sendHttpResponse(this.#client, 200, HTML, renderInvitePage({
        showUrl: this.config.invitePath + token + '/show'
      }));
      return this.destroy('Invite landing served');
    }

    const user = this.config.registry.mintable(result.label);
    // Revoked reads exactly like expired — distinguishing would confirm which
    // labels once existed.
    if (!user || !SAFE_LABEL.test(user.label)) return stale();

    if (!this.deps.burn.claim(result.nonce, result.exp * 1000, INVITE_GRACE_MS)) {
      return stale();
    }

    const host = this.#publicHost(req);
    if (!host) return stale();

    const params = new URLSearchParams(req.query || '');
    const profile = {
      uuid: user.uuid,
      host,
      port: this.config.publicPort,
      wsPath: this.config.wsPath,
      udp: params.get('udp') === '1'
    };

    if (action === '/conf.json') {
      const body = JSON.stringify(buildXrayConfig({
        ...profile,
        ca: this.config.interceptCa ? this.config.interceptCa.split('\\n') : null
      }), null, 2);
      const name = `vless-${user.label}${profile.udp ? '-udp' : ''}.json`;
      this.log('PROVISION', `Config downloaded for ${user.label}`);
      sendHttpResponse(this.#client, 200, JSON_TYPE, body, [
        `Content-Disposition: attachment; filename="${name}"`,
        'Referrer-Policy: no-referrer'
      ]);
      return this.destroy('Invite config served');
    }

    this.log('PROVISION', `Invite revealed for ${user.label}`);
    sendHttpResponse(this.#client, 200, HTML, renderRevealPage({
      label: user.label,
      link: buildVlessLink({ ...profile, label: user.label }),
      confUrl: this.config.invitePath + token + '/conf.json',
      confUdpUrl: this.config.invitePath + token + '/conf.json?udp=1'
    }), ['Referrer-Policy: no-referrer']);
    this.destroy('Invite revealed');
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
    // The registry matches any provisioned credential and reports which one,
    // so traffic can be attributed to a person rather than to the server.
    const result = parseVlessHeader(buf, this.config.registry);

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
    this.connInfo = this.stats.openConnection(result.user ? result.user.label : '');

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

function handleConnection(client, deps) {
  return new Session(client, deps).start();
}

// tokensMatch now lives in tokens.js alongside the rest of the signing code;
// re-exported here because that is where callers and tests already import it.
module.exports = { Session, handleConnection, tokensMatch };
