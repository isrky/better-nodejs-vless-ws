'use strict';

// Entry module for the Node build: accept a connection, decide whether it is
// TLS, hand it to a Session.
//
// createServer() is deliberately side-effect-free — no listen(), no console
// output, no timer that can hold the event loop open. That is what makes this
// module importable from a test, and it is worth keeping:
//
//   node -e "require('./src/node/server.js').createServer()"
//
// must exit immediately and silently.

const net = require('net');
const tls = require('tls');

const { loadConfig } = require('./config.js');
const { createStats } = require('./stats.js');
const { createDnsCache } = require('./dnscache.js');
const { createDohResolver } = require('./doh.js');
const { defaultTlsCredentials, looksLikeTls } = require('./tlscert.js');
const { log: defaultLog } = require('./log.js');
const { createBurnStore } = require('./tokens.js');
const { createRateLimiter } = require('./ratelimit.js');
const { createPinCache } = require('./certpin.js');
const { handleConnection, ADMIN_PATH } = require('./session.js');

/**
 * @param {object} options
 * @param {object} options.env             environment to read config from
 * @param {object} options.config          pre-built config (overrides env)
 * @param {object} options.stats           pre-built stats collector
 * @param {object} options.dns             pre-built DNS cache
 * @param {object} options.tlsCredentials  { cert, key }
 * @param {function} options.logger        (level, msg) => void
 */
function createServer(options = {}) {
  const config = options.config || loadConfig(options.env);
  const stats = options.stats || createStats(Date.now, { labels: config.registry.labels });
  const log = options.logger || defaultLog;
  const dns = options.dns || createDnsCache({
    ttl: config.dnsTtl,
    sweepInterval: config.dnsSweep,
    logger: log,
    // Falls through to the system resolver when DOH_URL is unset, and also
    // whenever DoH fails — see the breaker in doh.js.
    resolver: config.dohUrl
      ? createDohResolver({ url: config.dohUrl, timeoutMs: config.dohTimeoutMs, logger: log })
      : undefined
  });
  if (config.dohUrl) log('INFO', `DNS via ${config.dohUrl} (system resolver on failure)`);
  const credentials = options.tlsCredentials || defaultTlsCredentials;
  const burn = options.burn || createBurnStore();

  // A WSPATH that starts with the invite prefix would have its upgrades matched
  // by the invite router first. The handler guards against it, but the operator
  // should know the two are one edit away from colliding.
  if (config.provisioning && config.wsPath.startsWith(config.invitePath)) {
    log('WARN', `WSPATH ${config.wsPath} overlaps INVITE_PATH ${config.invitePath} — ` +
                'set INVITE_PATH to something else');
  }
  for (const bad of config.rejectedLabels) {
    log('WARN', `USERS entry ignored (invalid or reserved label): ${JSON.stringify(bad)}`);
  }
  if (!config.provisioning && config.registry.labels.length > 0) {
    log('WARN', 'USERS is set but PROVISION_SECRET is not — no users were derived');
  }

  // Per-instance, like stats: two servers in one process must not share limits.
  const limits = options.limits || {
    // One redemption costs three requests (landing, reveal, download), and
    // invitees on a school or corporate network all share one NAT address —
    // which is the common case for this deployment. A tight per-IP bucket would
    // lock out real people long before it inconvenienced anyone probing.
    invite: createRateLimiter({ capacity: 60, refillPerSecond: 1 }),
    // Never limits an AUTHORISED request: the stats stream is one long-lived
    // request and a reconnect loop must not be able to trip it.
    adminFail: createRateLimiter({ capacity: 20, refillPerSecond: 20 / 60 }),
    global: createRateLimiter({ capacity: 120, refillPerSecond: 2 })
  };

  // Domain-fronted invites need the SHA-256 of the cert the public edge serves
  // for the spoofed SNI. A configured FRONT_CERT_PIN wins (hairpin-proof, no
  // probe); otherwise self-probe lazily — constructing the cache is inert (no
  // probe, no timer), so createServer() stays side-effect free.
  const frontPin = options.frontPin || (
    config.frontPin
      ? { get: async () => config.frontPin, stop() {} }
      : (config.frontSni && config.publicHost)
        ? createPinCache({ host: config.publicHost, servername: config.frontSni, port: config.publicPort })
        : null);

  const deps = { config, stats, dns, log, burn, limits, frontPin };

  const server = net.createServer((socket) => {
    socket.on('error', () => { try { socket.destroy(); } catch (e) { /* gone */ } });

    socket.once('data', (chunk) => {
      socket.pause();
      socket.unshift(chunk);

      if (looksLikeTls(chunk)) {
        // TLSSocket drives the underlying socket itself; resume() must NOT be
        // called here or the unshifted ClientHello is consumed twice.
        const tlsSocket = new tls.TLSSocket(socket, {
          isServer: true,
          cert: credentials.cert,
          key: credentials.key
        });
        tlsSocket.on('error', () => { try { socket.destroy(); } catch (e) { /* gone */ } });
        tlsSocket.on('secure', () => handleConnection(tlsSocket, deps));
      } else {
        // The handler must be attached BEFORE resume(), or the unshifted
        // request bytes are dropped and the first request on every connection
        // silently hangs.
        handleConnection(socket, deps);
        socket.resume();
      }
    });
  });

  return {
    server,
    config,
    stats,
    dns,
    close(cb) {
      dns.stop();
      if (frontPin) frontPin.stop();
      server.close(cb);
    }
  };
}

/**
 * The startup banner as one string, kept pure so tests can assert on it
 * without binding a port. The Admin Stats URL is only printed when it would
 * actually work: PUBLIC_HOST gives it a real origin (https, port elided at
 * 443), and without ADMIN_TOKEN the route serves only the decoy, so a URL
 * would be a lie — same rule as adminUrl() in tools/credentials.mjs.
 */
function bannerText(config) {
  const origin = config.publicHost
    ? `https://${config.publicHost}${config.publicPort === 443 ? '' : `:${config.publicPort}`}`
    : `http://${config.host}:${config.port}`;
  const adminLine = config.adminToken
    ? `Admin Stats: ${origin}${ADMIN_PATH}?token=${encodeURIComponent(config.adminToken)}`
    : 'Admin Stats: disabled (set ADMIN_TOKEN)';
  return `\n Native vls-WS Server Active on ${config.host}:${config.port}\n` +
         `Path: ${config.wsPath}\nUUID: ${config.uuid}\n\n ${adminLine}\n`;
}

/** createServer() plus the port bind and the startup banner. */
function startServer(options = {}) {
  const handle = createServer(options);
  const { config } = handle;

  handle.server.listen(config.port, config.host, () => {
    console.log(bannerText(config));
  });

  return handle;
}

module.exports = { createServer, startServer, bannerText };
