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
const { defaultTlsCredentials, looksLikeTls } = require('./tlscert.js');
const { log: defaultLog } = require('./log.js');
const { handleConnection } = require('./session.js');

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
  const stats = options.stats || createStats();
  const log = options.logger || defaultLog;
  const dns = options.dns || createDnsCache({
    ttl: config.dnsTtl,
    sweepInterval: config.dnsSweep,
    logger: log
  });
  const credentials = options.tlsCredentials || defaultTlsCredentials;

  const deps = { config, stats, dns, log };

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
      server.close(cb);
    }
  };
}

/** createServer() plus the port bind and the startup banner. */
function startServer(options = {}) {
  const handle = createServer(options);
  const { config } = handle;

  handle.server.listen(config.port, config.host, () => {
    console.log(`\n Native vls-WS Server Active on ${config.host}:${config.port}\n` +
                `Path: ${config.wsPath}\nUUID: ${config.uuid}\n`);
    console.log(` Admin Stats: http://${config.host}:${config.port}/admin-stats\n`);
  });

  return handle;
}

module.exports = { createServer, startServer };
