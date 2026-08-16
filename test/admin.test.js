'use strict';

// The /admin-stats gate. Security-critical and cheap to assert exhaustively:
// when the endpoint is not unlocked it must be INDISTINGUISHABLE from the
// decoy page, or its existence — and the wsPath it prints — is disclosed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createServer } = require('../src/node/server.js');
const { loadConfig } = require('../src/node/config.js');
const { tokensMatch } = require('../src/node/session.js');
const { FAKE_INDEX_HTML } = require('../src/decoy.js');
const {
  rawRequest, rawRequestUntil, readSseEvents, splitResponse, get
} = require('./helpers/rawclient.js');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DECOY = sha256(FAKE_INDEX_HTML);

function start(env) {
  return new Promise((resolve) => {
    const handle = createServer({ config: loadConfig(env), logger: () => {} });

    // The stream endpoint holds its socket open, and net.Server#close() waits
    // for every connection — track and destroy them or teardown deadlocks.
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

const req = (path) => `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`;

async function bodyOf(port, path, method = 'GET') {
  const raw = await rawRequest(port, `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
  return splitResponse(raw).body;
}

test('with ADMIN_TOKEN unset the endpoint is hidden entirely', async (t) => {
  const srv = await start({ ADMIN_TOKEN: '', WSPATH: '/secret-path' });
  t.after(() => srv.close());

  for (const path of ['/admin-stats', '/admin-stats?token=', '/admin-stats?token=anything']) {
    const body = await bodyOf(srv.port, path);
    assert.equal(sha256(body), DECOY, `${path} must be the decoy`);
    assert.ok(!body.includes('secret-path'), 'the ws path must not leak');
  }
});

test('with ADMIN_TOKEN set the dashboard needs the exact token', async (t) => {
  const srv = await start({ ADMIN_TOKEN: 's3cret', WSPATH: '/tunnel' });
  t.after(() => srv.close());

  for (const path of [
    '/admin-stats',
    '/admin-stats?token=',
    '/admin-stats?token=wrong',
    '/admin-stats?token=s3cre',      // prefix
    '/admin-stats?token=s3cretx',    // extension
    '/admin-stats?tok=s3cret'        // wrong parameter
  ]) {
    assert.equal(sha256(await bodyOf(srv.port, path)), DECOY, `${path} must be gated`);
  }

  const ok = await bodyOf(srv.port, '/admin-stats?token=s3cret');
  assert.notEqual(sha256(ok), DECOY);
  assert.match(ok.toString(), /Server Statistics Dashboard/);
  assert.match(ok.toString(), /\/tunnel/, 'the unlocked page does show the ws path');
});

test('the gate is GET-only and exact-path', async (t) => {
  const srv = await start({ ADMIN_TOKEN: 's3cret' });
  t.after(() => srv.close());

  assert.equal(sha256(await bodyOf(srv.port, '/admin-stats?token=s3cret', 'POST')), DECOY);
  assert.equal(sha256(await bodyOf(srv.port, '/admin-stats-x?token=s3cret')), DECOY);
  assert.equal(sha256(await bodyOf(srv.port, '/Admin-Stats?token=s3cret')), DECOY);
});

test('extra query parameters around the token are fine', async (t) => {
  const srv = await start({ ADMIN_TOKEN: 's3cret' });
  t.after(() => srv.close());

  const body = await bodyOf(srv.port, '/admin-stats?a=1&token=s3cret&b=2');
  assert.match(body.toString(), /Server Statistics Dashboard/);
});

test('tokensMatch is length-safe and rejects non-strings', () => {
  assert.equal(tokensMatch('abc', 'abc'), true);
  assert.equal(tokensMatch('abc', 'abd'), false);
  assert.equal(tokensMatch('ab', 'abc'), false, 'different lengths must not throw');
  assert.equal(tokensMatch('abcd', 'abc'), false);
  assert.equal(tokensMatch(null, 'abc'), false);
  assert.equal(tokensMatch(undefined, 'abc'), false);
  assert.equal(tokensMatch('', ''), true);
});

test('a request head that never terminates is dropped rather than buffered forever', async (t) => {
  const srv = await start({});
  t.after(() => srv.close());

  const net = require('net');
  const closed = await new Promise((resolve, reject) => {
    const socket = net.connect(srv.port, '127.0.0.1', () => {
      // A well-formed request line, then headers forever and no \r\n\r\n.
      socket.write('GET / HTTP/1.1\r\n');
      const pump = setInterval(() => {
        if (socket.destroyed || !socket.writable) return clearInterval(pump);
        socket.write('X-Filler: ' + 'a'.repeat(2048) + '\r\n');
      }, 1);
      socket.on('close', () => { clearInterval(pump); resolve(true); });
    });
    socket.on('error', () => resolve(true));
    setTimeout(() => reject(new Error('server kept buffering an unbounded head')), 8000);
  });

  assert.equal(closed, true);
});

test('Content-Length is the byte length, not the character count', () => {
  // A non-ASCII body (an IDN destination on the stats page) is longer in bytes
  // than in JS characters; declaring the character count truncates it.
  const { sendHttpResponse } = require('../src/node/http.js');

  let written = '';
  const fake = { write: (s) => { written += s; } };
  const body = 'héllo — münchen';

  sendHttpResponse(fake, 200, 'text/html', body);

  const declared = Number(written.match(/Content-Length: (\d+)/)[1]);
  assert.equal(declared, Buffer.byteLength(body));
  assert.notEqual(declared, body.length, 'the two genuinely differ here');
});

// ==========================================
// The live stats stream
// ==========================================

test('the stream endpoint is gated exactly like the page', async (t) => {
  const srv = await start({ ADMIN_TOKEN: 's3cret', WSPATH: '/tunnel' });
  t.after(() => srv.close());

  // An unauthorised probe of the stream must be byte-identical to one of the
  // page, which is byte-identical to GET / — so probing discloses nothing.
  for (const path of [
    '/admin-stats/stream',
    '/admin-stats/stream?token=',
    '/admin-stats/stream?token=wrong',
    '/admin-stats/stream?token=s3cre',
    '/admin-stats/stream?token=s3cretx',
    '/admin-stats/stream?tok=s3cret',
    '/Admin-Stats/Stream?token=s3cret',
    '/admin-stats/stream-x?token=s3cret'
  ]) {
    assert.equal(sha256(await bodyOf(srv.port, path)), DECOY, `${path} must be gated`);
  }

  assert.equal(sha256(await bodyOf(srv.port, '/admin-stats/stream?token=s3cret', 'POST')), DECOY,
    'the stream is GET-only');
});

test('with ADMIN_TOKEN unset the stream is hidden entirely', async (t) => {
  const srv = await start({ ADMIN_TOKEN: '', WSPATH: '/secret-path' });
  t.after(() => srv.close());

  const body = await bodyOf(srv.port, '/admin-stats/stream?token=anything');
  assert.equal(sha256(body), DECOY);
  assert.ok(!body.includes('secret-path'));
});

test('an authorised stream is chunked with no Content-Length', async (t) => {
  const srv = await start({ ADMIN_TOKEN: 's3cret' });
  t.after(() => srv.close());

  const { head } = await readSseEvents(srv.port, '/admin-stats/stream?token=s3cret', 1);

  assert.match(head, /^HTTP\/1\.1 200 OK/);
  assert.match(head, /Content-Type: text\/event-stream/);
  assert.match(head, /Transfer-Encoding: chunked/);
  assert.match(head, /X-Accel-Buffering: no/);
  assert.ok(!/Content-Length:/i.test(head), 'a stream must not declare a length');
  assert.ok(!/Connection: close/i.test(head));
});

test('the first event arrives immediately, not after the first interval', async (t) => {
  const srv = await start({ ADMIN_TOKEN: 's3cret' });
  t.after(() => srv.close());

  const started = Date.now();
  const { events } = await readSseEvents(srv.port, '/admin-stats/stream?token=s3cret', 1);
  const elapsed = Date.now() - started;

  assert.equal(events.length >= 1, true);
  assert.ok(elapsed < 500, `first paint should not wait a full tick (took ${elapsed}ms)`);
});

test('events are full snapshots carrying every rendered field', async (t) => {
  const srv = await start({ ADMIN_TOKEN: 's3cret' });
  t.after(() => srv.close());

  const { events } = await readSseEvents(srv.port, '/admin-stats/stream?token=s3cret', 2);
  assert.ok(events.length >= 2);

  for (const e of events) {
    for (const key of [
      'uptimeSeconds', 'totalConnections', 'activeConnections', 'totalStreams',
      'activeStreams', 'totalBytesTx', 'totalBytesRx', 'tcpStreams', 'udpStreams',
      'muxSessions'
    ]) {
      assert.equal(typeof e[key], 'number', `${key} must be present on every event`);
    }
    assert.ok(Array.isArray(e.active));
    assert.ok(Array.isArray(e.history));
  }

  // Live, not a cached first snapshot replayed.
  assert.ok(events[1].uptimeSeconds >= events[0].uptimeSeconds);
});

test('a multibyte payload survives chunk framing', async (t) => {
  // The chunk size prefix counts BYTES. If it ever counts JS characters, a
  // non-ASCII hostname desynchronises the stream permanently and the dashboard
  // stops updating with no error raised anywhere — this is that regression test.
  const host = 'münchen-café-数据.example:443';
  const stats = require('../src/node/stats.js').createStats();
  const conn = stats.openConnection();
  stats.startStream(conn, 'TCP', host, 443);

  const handle = createServer({
    config: loadConfig({ ADMIN_TOKEN: 's3cret' }), stats, logger: () => {}
  });
  const open = new Set();
  handle.server.on('connection', (s) => { open.add(s); s.on('close', () => open.delete(s)); });
  await new Promise((r) => handle.server.listen(0, '127.0.0.1', r));
  const port = handle.server.address().port;
  t.after(() => new Promise((done) => { handle.close(done); for (const s of open) s.destroy(); }));

  const { events } = await readSseEvents(port, '/admin-stats/stream?token=s3cret', 2);

  assert.ok(events.length >= 2, 'the stream must survive past the multibyte event');
  assert.equal(events[0].active[0].lastHost, `${host}:443`);
  assert.equal(events[1].active[0].lastHost, `${host}:443`);
});

test('the dashboard points at the stream and carries the token across', async (t) => {
  const srv = await start({ ADMIN_TOKEN: 's3cret' });
  t.after(() => srv.close());

  const html = (await bodyOf(srv.port, '/admin-stats?token=s3cret')).toString();

  // The token must never be interpolated into the script — the client derives
  // the stream URL from location, so there is no second place to get it wrong.
  assert.match(html, /location\.pathname \+ '\/stream' \+ location\.search/);
  assert.ok(!html.includes('s3cret'), 'the token must not be baked into the page');
});

// ==========================================
// Stats count tunnels, not HTTP hits
// ==========================================

test('decoy hits, dashboard loads and the stream are not counted', async (t) => {
  const srv = await start({ ADMIN_TOKEN: 's3cret' });
  t.after(() => srv.close());

  await rawRequest(srv.port, get('/'));                      // a health check
  await rawRequest(srv.port, get('/'));
  await rawRequest(srv.port, get('/nope'));
  await bodyOf(srv.port, '/admin-stats?token=s3cret');       // a dashboard load
  await bodyOf(srv.port, '/admin-stats');                    // a gated probe
  await readSseEvents(srv.port, '/admin-stats/stream?token=s3cret', 1);

  const snap = srv.handle.stats.snapshot();
  assert.equal(snap.totalConnections, 0, 'only validated tunnels count');
  assert.equal(snap.activeConnections, 0);
  assert.deepEqual(snap.history, [], 'and none of them pollute the history table');
});

test('an unfinished connection is not counted either', async (t) => {
  const srv = await start({ ADMIN_TOKEN: 's3cret' });
  t.after(() => srv.close());

  // Upgrade to WebSocket but never send a VLESS header.
  await rawRequestUntil(
    srv.port,
    get('/', 'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'),
    (buf) => buf.includes('\r\n\r\n'),
    2000
  );

  assert.equal(srv.handle.stats.snapshot().totalConnections, 0);
});
