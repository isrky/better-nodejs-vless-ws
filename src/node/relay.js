'use strict';

// VLESS CMD 1 — a plain TCP tunnel.
//
// One target socket for the lifetime of the session; every WebSocket message
// after the header is opaque payload. Mirrors src/worker/relay.mjs.

const net = require('net');
const dns = require('dns');

const { OPCODE } = require('./wsframe.js');
const { ByteQueue } = require('../vless.js');

/**
 * Resolve through the session's DNS cache instead of getaddrinfo.
 *
 * Without this the TCP path silently keeps using the system resolver: the cache
 * is only wired into UDP sends, so a DoH resolver would cover a fraction of
 * lookups while looking finished. It also removes an uncached getaddrinfo per
 * connection.
 *
 * The cache is A-only, so anything it cannot answer — an IPv6-only host, most
 * obviously — falls through to Node's own lookup rather than becoming
 * unreachable.
 */
function cachedLookup(session) {
  if (!session.dns || typeof session.dns.resolve !== 'function') return undefined;

  return function lookup(hostname, options, callback) {
    session.dns.resolve(hostname, (err, address) => {
      if (err || !address) return dns.lookup(hostname, options, callback);
      // net asks for the array form when it wants every candidate.
      if (options && options.all) return callback(null, [{ address, family: 4 }]);
      callback(null, address, 4);
    });
  };
}

/**
 * @param {Session} session  see the contract at the top of session.js
 * @param {string}  host
 * @param {number}  port
 * @param {Uint8Array} initial  payload that arrived with the VLESS header
 */
function createTcpRelay(session, host, port, initial) {
  const record = session.stats.startStream(session.connInfo, 'TCP', host, port);
  session.log('TCP', `Tunnel connecting to ${host}:${port}`);

  // Buffers writes that arrive before the connection is established.
  const pendingWrites = new ByteQueue();
  let connected = false;
  let closed = false;

  if (initial && initial.length > 0) pendingWrites.push(initial);

  const target = net.createConnection({ host, port, lookup: cachedLookup(session) }, () => {
    connected = true;
    if (pendingWrites.size === 0) return;
    const buffered = pendingWrites.flatten();
    session.stats.addTx(session.connInfo, record, buffered.length);
    if (!target.write(buffered)) session.pauseClient();
    pendingWrites.clear();
  });

  target.on('data', (chunk) => {
    if (session.dead) return;
    session.stats.addRx(session.connInfo, record, chunk.length);
    // Registering with the session (rather than calling target.pause()
    // directly) is what gets this socket resumed on the client's 'drain'.
    if (!session.sendWs(OPCODE.BINARY, chunk)) session.pauseSource(target);
  });

  target.on('drain', () => session.resumeClient());
  target.on('close', () => session.destroy('TCP Target Closed'));
  target.on('error', (e) => session.destroy('TCP Target Error: ' + e));

  return {
    write(payload) {
      if (!payload || payload.length === 0) return;
      if (!connected) {
        pendingWrites.push(payload);
        return;
      }
      session.stats.addTx(session.connInfo, record, payload.length);
      if (!target.write(payload)) session.pauseClient();
    },

    close() {
      if (closed) return;
      closed = true;
      session.stats.endStream(record);
      pendingWrites.clear();
      target.removeAllListeners('data');
      target.removeAllListeners('drain');
      target.removeAllListeners('error');
      target.removeAllListeners('close');
      try { target.destroy(); } catch (e) { /* already gone */ }
    }
  };
}

module.exports = { createTcpRelay };
