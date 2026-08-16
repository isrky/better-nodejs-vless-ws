'use strict';

// VLESS CMD 2 — the legacy single-target UDP association.
//
// Datagrams are carried over the WebSocket stream with a 2-byte big-endian
// length prefix in both directions, since a stream has no packet boundaries of
// its own. Modern clients use Mux/xUDP (mux.js) instead; this path is kept for
// older ones, and is what a plain DNS-over-UDP query through the tunnel uses.

const dgram = require('dgram');

const { OPCODE } = require('./wsframe.js');
const { ByteQueue } = require('../vless.js');

function createUdpRelay(session, host, port, initial) {
  const record = session.stats.startStream(session.connInfo, 'UDP', host, port);
  session.log('UDP', `Legacy UDP Session Started: ${host}:${port}`);

  const inbound = new ByteQueue();
  let closed = false;

  const socket = dgram.createSocket('udp4');
  socket.bind(0, '0.0.0.0');

  socket.on('message', (reply) => {
    if (session.dead) return;
    session.stats.addRx(session.connInfo, record, reply.length);

    const framed = Buffer.allocUnsafe(2 + reply.length);
    framed[0] = (reply.length >>> 8) & 0xff;
    framed[1] = reply.length & 0xff;
    framed.set(reply, 2);
    session.sendWs(OPCODE.BINARY, framed);
  });

  socket.on('error', (e) => session.destroy('UDP Socket Error: ' + e));

  function write(payload) {
    if (payload && payload.length > 0) inbound.push(payload);

    // Drain as many complete length-prefixed datagrams as have arrived.
    for (;;) {
      if (inbound.size < 2) return;
      const len = (inbound.at(0) << 8) | inbound.at(1);
      if (inbound.size < 2 + len) return;

      const packet = inbound.slice(2, 2 + len);
      inbound.consume(2 + len);

      session.stats.addTx(session.connInfo, record, packet.length);
      session.dns.resolveAndSend(socket, packet, port, host, () => {});
    }
  }

  if (initial && initial.length > 0) write(initial);

  return {
    write,

    close() {
      if (closed) return;
      closed = true;
      session.stats.endStream(record);
      inbound.clear();
      socket.removeAllListeners('message');
      socket.removeAllListeners('error');
      try { socket.close(); } catch (e) { /* already closed */ }
    }
  };
}

module.exports = { createUdpRelay };
