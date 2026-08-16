'use strict';

// End-to-end proof that all three VLESS paths still carry traffic after the
// split into relay.js / udp.js / mux.js: a real WebSocket client speaks VLESS
// to a real server, which relays to a real echo target.
//
// This is the test that would have caught the silent Buffer -> Uint8Array
// failures: a mux domain parsed with Buffer#toString('utf8', a, b) turns into
// "104,101,..." and the substream dies without ever throwing.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const dgram = require('dgram');

const { createServer } = require('../src/node/server.js');
const { loadConfig } = require('../src/node/config.js');
const {
  connectWs, vlessHeader, muxFrame, muxNewMeta, muxNewDomainMeta, muxKeepMeta
} = require('./helpers/wsclient.js');

const UUID = '7bd180e8-1142-4387-93f5-03e8d750a896';
const config = loadConfig({ UUID, WSPATH: '/', ADMIN_TOKEN: '' });
const quiet = () => {};

/** A TCP server that echoes back everything it receives, uppercased. */
function startTcpEcho() {
  return new Promise((resolve) => {
    const open = new Set();
    const server = net.createServer((s) => {
      open.add(s);
      s.on('close', () => open.delete(s));
      s.on('data', (d) => s.write(Buffer.from(d.toString('utf8').toUpperCase())));
      s.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((done) => {
        server.close(done);
        for (const s of open) s.destroy();
      })
    }));
  });
}

/** A UDP server that echoes each datagram back, uppercased. */
function startUdpEcho() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.on('message', (msg, rinfo) => {
      socket.send(Buffer.from(msg.toString('utf8').toUpperCase()), rinfo.port, rinfo.address);
    });
    socket.bind(0, '127.0.0.1', () => resolve({
      port: socket.address().port,
      close: () => new Promise((done) => { socket.close(done); })
    }));
  });
}

function startProxy() {
  return new Promise((resolve) => {
    const handle = createServer({ config, logger: quiet });

    // net.Server#close() waits for every open connection, and these tests
    // deliberately leave tunnels open — so track and destroy them, otherwise
    // teardown deadlocks and the runner hangs until it is killed.
    const open = new Set();
    handle.server.on('connection', (s) => {
      open.add(s);
      s.on('close', () => open.delete(s));
    });

    handle.server.listen(0, '127.0.0.1', () => resolve({
      port: handle.server.address().port,
      handle,
      close: () => new Promise((done) => {
        handle.close(done);
        for (const s of open) s.destroy();
      })
    }));
  });
}

test('VLESS CMD 1 (TCP) relays traffic both ways', { timeout: 15000 }, async (t) => {
  const echo = await startTcpEcho();
  const proxy = await startProxy();
  t.after(async () => { await proxy.close(); await echo.close(); });

  const ws = await connectWs(proxy.port);
  t.after(() => ws.close());

  // Header and first payload in one message, as a real client sends it.
  ws.send(Buffer.concat([
    vlessHeader(config.uuidBytes, 1, '127.0.0.1', echo.port),
    Buffer.from('hello')
  ]));

  const ok = await ws.next();
  assert.deepEqual(ok, Buffer.from([0x00, 0x00]), 'VLESS OK header first');

  assert.equal((await ws.next()).toString(), 'HELLO');

  // And a subsequent message on the established tunnel.
  ws.send(Buffer.from('again'));
  assert.equal((await ws.next()).toString(), 'AGAIN');
});

test('a VLESS header split across two WebSocket messages still parses', { timeout: 15000 }, async (t) => {
  const echo = await startTcpEcho();
  const proxy = await startProxy();
  t.after(async () => { await proxy.close(); await echo.close(); });

  const ws = await connectWs(proxy.port);
  t.after(() => ws.close());

  const header = vlessHeader(config.uuidBytes, 1, '127.0.0.1', echo.port);
  ws.send(header.subarray(0, 10));
  ws.send(Buffer.concat([header.subarray(10), Buffer.from('split')]));

  assert.deepEqual(await ws.next(), Buffer.from([0x00, 0x00]));
  assert.equal((await ws.next()).toString(), 'SPLIT');
});

test('a bad UUID is rejected with the decoy page, not an error', { timeout: 15000 }, async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());

  const ws = await connectWs(proxy.port);
  t.after(() => ws.close());

  const wrong = Buffer.alloc(16, 0xff);
  const closed = new Promise((resolve) => ws.socket.once('close', resolve));

  ws.send(Buffer.concat([vlessHeader(wrong, 1, '127.0.0.1', 9), Buffer.from('x')]));

  // The server answers with the cover page and hangs up rather than saying no
  // — an authentication failure must be indistinguishable from a plain web
  // server, so there is nothing to probe for.
  await closed;
  assert.equal(ws.socket.destroyed, true);
});

test('VLESS CMD 2 (legacy UDP) carries length-prefixed datagrams', { timeout: 15000 }, async (t) => {
  const echo = await startUdpEcho();
  const proxy = await startProxy();
  t.after(async () => { await proxy.close(); await echo.close(); });

  const ws = await connectWs(proxy.port);
  t.after(() => ws.close());

  const packet = Buffer.from('ping');
  const framed = Buffer.concat([Buffer.from([0x00, packet.length]), packet]);

  ws.send(Buffer.concat([
    vlessHeader(config.uuidBytes, 2, '127.0.0.1', echo.port),
    framed
  ]));

  assert.deepEqual(await ws.next(), Buffer.from([0x00, 0x00]));

  const reply = await ws.next();
  assert.equal((reply[0] << 8) | reply[1], 4, 'reply carries a 2-byte length prefix');
  assert.equal(reply.subarray(2).toString(), 'PING');
});

test('VLESS CMD 3 (Mux.Cool) opens a TCP substream and relays it', { timeout: 15000 }, async (t) => {
  const echo = await startTcpEcho();
  const proxy = await startProxy();
  t.after(async () => { await proxy.close(); await echo.close(); });

  const ws = await connectWs(proxy.port);
  t.after(() => ws.close());

  ws.send(vlessHeader(config.uuidBytes, 3));
  assert.deepEqual(await ws.next(), Buffer.from([0x00, 0x00]));

  ws.send(muxFrame(muxNewMeta(7, 1, '127.0.0.1', echo.port), Buffer.from('mux')));

  const frame = await ws.next();
  const metaLen = (frame[0] << 8) | frame[1];
  const meta = frame.subarray(2, 2 + metaLen);
  assert.equal((meta[0] << 8) | meta[1], 7, 'substream id echoed back');
  assert.equal(meta[2], 2, 'cmd Keep');

  const dataLen = (frame[2 + metaLen] << 8) | frame[3 + metaLen];
  assert.equal(frame.subarray(4 + metaLen, 4 + metaLen + dataLen).toString(), 'MUX');
});

test('Mux carries two independent substreams at once', { timeout: 15000 }, async (t) => {
  const echo = await startTcpEcho();
  const proxy = await startProxy();
  t.after(async () => { await proxy.close(); await echo.close(); });

  const ws = await connectWs(proxy.port);
  t.after(() => ws.close());

  ws.send(vlessHeader(config.uuidBytes, 3));
  assert.deepEqual(await ws.next(), Buffer.from([0x00, 0x00]));

  ws.send(muxFrame(muxNewMeta(1, 1, '127.0.0.1', echo.port), Buffer.from('one')));
  ws.send(muxFrame(muxNewMeta(2, 1, '127.0.0.1', echo.port), Buffer.from('two')));

  const seen = new Map();
  while (seen.size < 2) {
    const frame = await ws.next();
    const metaLen = (frame[0] << 8) | frame[1];
    const meta = frame.subarray(2, 2 + metaLen);
    const id = (meta[0] << 8) | meta[1];
    if (meta[2] !== 2) continue;      // ignore End frames
    const dataLen = (frame[2 + metaLen] << 8) | frame[3 + metaLen];
    seen.set(id, frame.subarray(4 + metaLen, 4 + metaLen + dataLen).toString());
  }

  assert.equal(seen.get(1), 'ONE');
  assert.equal(seen.get(2), 'TWO');
});

test('a Mux frame delivered in three chunks is reassembled', { timeout: 15000 }, async (t) => {
  const echo = await startTcpEcho();
  const proxy = await startProxy();
  t.after(async () => { await proxy.close(); await echo.close(); });

  const ws = await connectWs(proxy.port);
  t.after(() => ws.close());

  ws.send(vlessHeader(config.uuidBytes, 3));
  assert.deepEqual(await ws.next(), Buffer.from([0x00, 0x00]));

  const frame = muxFrame(muxNewMeta(3, 1, '127.0.0.1', echo.port), Buffer.from('chunked'));
  ws.send(frame.subarray(0, 3));
  ws.send(frame.subarray(3, 9));
  ws.send(frame.subarray(9));

  const reply = await ws.next();
  const metaLen = (reply[0] << 8) | reply[1];
  const dataLen = (reply[2 + metaLen] << 8) | reply[3 + metaLen];
  assert.equal(reply.subarray(4 + metaLen, 4 + metaLen + dataLen).toString(), 'CHUNKED');
});

test('a Mux Keep frame writes more data to an open substream', { timeout: 15000 }, async (t) => {
  const echo = await startTcpEcho();
  const proxy = await startProxy();
  t.after(async () => { await proxy.close(); await echo.close(); });

  const ws = await connectWs(proxy.port);
  t.after(() => ws.close());

  ws.send(vlessHeader(config.uuidBytes, 3));
  assert.deepEqual(await ws.next(), Buffer.from([0x00, 0x00]));

  ws.send(muxFrame(muxNewMeta(9, 1, '127.0.0.1', echo.port), Buffer.from('first')));
  await ws.next();

  ws.send(muxFrame(muxKeepMeta(9), Buffer.from('second')));

  const reply = await ws.next();
  const metaLen = (reply[0] << 8) | reply[1];
  const dataLen = (reply[2 + metaLen] << 8) | reply[3 + metaLen];
  assert.equal(reply.subarray(4 + metaLen, 4 + metaLen + dataLen).toString(), 'SECOND');
});

test('a Mux substream to a blocked domain is refused', { timeout: 15000 }, async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());

  const ws = await connectWs(proxy.port);
  t.after(() => ws.close());

  ws.send(vlessHeader(config.uuidBytes, 3));
  assert.deepEqual(await ws.next(), Buffer.from([0x00, 0x00]));

  // The direct path gets this from parseVlessHeader and the Worker's mux path
  // enforces it too. Before the fix, the Node mux path checked nothing, so any
  // mux-capable client could route straight around the blocklist.
  ws.send(muxFrame(muxNewDomainMeta(11, 1, 'speedtest.net', 443), Buffer.from('x')));

  const frame = await ws.next();
  const metaLen = (frame[0] << 8) | frame[1];
  const meta = frame.subarray(2, 2 + metaLen);
  assert.equal((meta[0] << 8) | meta[1], 11, 'substream id');
  assert.equal(meta[2], 3, 'cmd End - the substream is refused, not opened');
});

test('a Mux substream to a subdomain of a blocked domain is refused', { timeout: 15000 }, async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());

  const ws = await connectWs(proxy.port);
  t.after(() => ws.close());

  ws.send(vlessHeader(config.uuidBytes, 3));
  assert.deepEqual(await ws.next(), Buffer.from([0x00, 0x00]));

  ws.send(muxFrame(muxNewDomainMeta(12, 1, 'www.speedtest.net', 443), Buffer.from('x')));

  const frame = await ws.next();
  const metaLen = (frame[0] << 8) | frame[1];
  assert.equal(frame.subarray(2, 2 + metaLen)[2], 3, 'cmd End');
});

test('a Mux substream to an allowed domain still opens', { timeout: 15000 }, async (t) => {
  const echo = await startTcpEcho();
  const proxy = await startProxy();
  t.after(async () => { await proxy.close(); await echo.close(); });

  const ws = await connectWs(proxy.port);
  t.after(() => ws.close());

  ws.send(vlessHeader(config.uuidBytes, 3));
  assert.deepEqual(await ws.next(), Buffer.from([0x00, 0x00]));

  // atyp 2 with a name that resolves locally, proving the domain path itself
  // works -- this is what Buffer#toString('utf8', a, b) silently corrupted.
  ws.send(muxFrame(muxNewDomainMeta(13, 1, 'localhost', echo.port), Buffer.from('named')));

  const frame = await ws.next();
  const metaLen = (frame[0] << 8) | frame[1];
  const meta = frame.subarray(2, 2 + metaLen);
  assert.equal(meta[2], 2, 'cmd Keep - the substream opened');
  const dataLen = (frame[2 + metaLen] << 8) | frame[3 + metaLen];
  assert.equal(frame.subarray(4 + metaLen, 4 + metaLen + dataLen).toString(), 'NAMED');
});

test('a validated tunnel IS counted', { timeout: 15000 }, async (t) => {
  // The other half of the stats carve-out: HTTP hits must not count (see
  // admin.test.js), but a real tunnel must.
  const echo = await startTcpEcho();
  const proxy = await startProxy();
  t.after(async () => { await proxy.close(); await echo.close(); });

  const ws = await connectWs(proxy.port);
  t.after(() => ws.close());

  assert.equal(proxy.handle.stats.snapshot().totalConnections, 0, 'nothing yet');

  ws.send(Buffer.concat([
    vlessHeader(config.uuidBytes, 1, '127.0.0.1', echo.port),
    Buffer.from('counted')
  ]));
  assert.deepEqual(await ws.next(), Buffer.from([0x00, 0x00]));
  assert.equal((await ws.next()).toString(), 'COUNTED');

  const snap = proxy.handle.stats.snapshot();
  assert.equal(snap.totalConnections, 1);
  assert.equal(snap.activeConnections, 1);
  assert.equal(snap.active[0].lastHost, `127.0.0.1:${echo.port}`);
  assert.ok(snap.totalBytesTx > 0, 'and its bytes are attributed');
});
