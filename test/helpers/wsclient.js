'use strict';

// A minimal client-side WebSocket + VLESS speaker for the end-to-end tests.
//
// Deliberately independent of src/node/wsframe.js for the client->server
// direction: it masks frames by hand, so a bug in the server's decoder cannot
// be cancelled out by the same bug in the test's encoder. Server->client
// frames are decoded with the real decoder, which is separately unit-tested.

const net = require('net');
const crypto = require('crypto');

const { decodeFrame } = require('../../src/node/wsframe.js');

/** Mask and frame a client->server message (clients MUST mask, RFC 6455). */
function clientFrame(opcode, payload) {
  const plen = payload.length;
  const head = [0x80 | opcode];

  if (plen <= 125) head.push(0x80 | plen);
  else if (plen <= 65535) head.push(0x80 | 126, plen >>> 8, plen & 0xff);
  else {
    head.push(0x80 | 127, 0, 0, 0, 0,
      (plen >>> 24) & 0xff, (plen >>> 16) & 0xff, (plen >>> 8) & 0xff, plen & 0xff);
  }

  const mask = crypto.randomBytes(4);
  head.push(...mask);

  const masked = Buffer.allocUnsafe(plen);
  for (let i = 0; i < plen; i++) masked[i] = payload[i] ^ mask[i & 3];

  return Buffer.concat([Buffer.from(head), masked]);
}

/** Build a VLESS request header. cmd 1 = TCP, 2 = UDP, 3 = Mux.Cool. */
function vlessHeader(uuidBytes, cmd, host, port) {
  const parts = [Buffer.from([0x00]), Buffer.from(uuidBytes), Buffer.from([0x00]), Buffer.from([cmd])];

  // Mux.Cool addresses each substream inside its own frames, so it carries no
  // address of its own.
  if (cmd !== 3) {
    parts.push(Buffer.from([(port >>> 8) & 0xff, port & 0xff]));
    const quad = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (quad) {
      parts.push(Buffer.from([0x01, +quad[1], +quad[2], +quad[3], +quad[4]]));
    } else {
      const name = Buffer.from(host, 'utf8');
      parts.push(Buffer.from([0x02, name.length]), name);
    }
  }

  return Buffer.concat(parts);
}

/** Build a Mux.Cool frame: u16 metaLen | meta | (u16 dataLen | data)? */
function muxFrame(meta, data) {
  const parts = [Buffer.from([(meta.length >>> 8) & 0xff, meta.length & 0xff]), Buffer.from(meta)];
  if (data) {
    parts.push(Buffer.from([(data.length >>> 8) & 0xff, data.length & 0xff]), Buffer.from(data));
  }
  return Buffer.concat(parts);
}

/** meta for "open substream `id`" against an IPv4 target. */
function muxNewMeta(id, network, host, port) {
  const quad = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return Buffer.from([
    (id >>> 8) & 0xff, id & 0xff,
    1,            // cmd: New
    1,            // opt: data follows
    network,      // 1 = TCP, 2 = UDP
    (port >>> 8) & 0xff, port & 0xff,
    0x01,         // atyp: IPv4
    +quad[1], +quad[2], +quad[3], +quad[4]
  ]);
}

/** meta for "open substream `id`" against a domain name (atyp 2). */
function muxNewDomainMeta(id, network, host, port) {
  const name = Buffer.from(host, 'utf8');
  return Buffer.concat([
    Buffer.from([
      (id >>> 8) & 0xff, id & 0xff,
      1,            // cmd: New
      1,            // opt: data follows
      network,
      (port >>> 8) & 0xff, port & 0xff,
      0x02,         // atyp: domain
      name.length
    ]),
    name
  ]);
}

/** meta for "substream `id`, more data" with no address restatement. */
function muxKeepMeta(id) {
  return Buffer.from([(id >>> 8) & 0xff, id & 0xff, 2, 1]);
}

/**
 * Connect, perform the WebSocket handshake, and return a small client.
 *
 * `messages()` yields decoded server->client payloads in order; `next()`
 * awaits the next one.
 */
function connectWs(port, path = '/') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');

    let handshakeDone = false;
    let buffer = Buffer.alloc(0);

    const received = [];
    const waiters = [];

    function deliver(payload) {
      if (waiters.length) waiters.shift().resolve(payload);
      else received.push(payload);
    }

    socket.on('error', reject);
    socket.on('close', () => {
      while (waiters.length) waiters.shift().reject(new Error('socket closed'));
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!handshakeDone) {
        const eoh = buffer.indexOf('\r\n\r\n');
        if (eoh === -1) return;
        const head = buffer.subarray(0, eoh).toString('utf8');
        buffer = buffer.subarray(eoh + 4);
        if (!/^HTTP\/1\.1 101/.test(head)) return reject(new Error('upgrade failed: ' + head));
        handshakeDone = true;
      }

      for (;;) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);
        if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
          deliver(Buffer.from(frame.payload));
        }
      }
    });

    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );

    // The server sends nothing until it has a VLESS header, so resolve as soon
    // as the socket is up and let the first read complete the handshake.
    socket.once('connect', () => {
      resolve({
        socket,
        send: (payload, opcode = 0x2) => socket.write(clientFrame(opcode, payload)),
        next: (timeoutMs = 2000) => {
          if (received.length) return Promise.resolve(received.shift());
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('timed out waiting for a message')), timeoutMs);
            waiters.push({
              resolve: (v) => { clearTimeout(timer); res(v); },
              reject: (e) => { clearTimeout(timer); rej(e); }
            });
          });
        },
        // Idempotent: the server hangs up on its own in several tests, and
        // waiting for a 'close' that already fired would stall teardown.
        close: () => new Promise((done) => {
          if (socket.destroyed) return done();
          socket.once('close', done);
          socket.destroy();
        })
      });
    });
  });
}

module.exports = {
  connectWs, clientFrame, vlessHeader, muxFrame, muxNewMeta, muxNewDomainMeta, muxKeepMeta
};
