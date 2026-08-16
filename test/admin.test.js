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
const { rawRequest, splitResponse } = require('./helpers/rawclient.js');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DECOY = sha256(FAKE_INDEX_HTML);

function start(env) {
  return new Promise((resolve) => {
    const handle = createServer({ config: loadConfig(env), logger: () => {} });
    handle.server.listen(0, '127.0.0.1', () => resolve({
      port: handle.server.address().port,
      close: () => new Promise((done) => handle.close(done))
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
