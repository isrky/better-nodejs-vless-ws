'use strict';

// Guards the HTTP head parser across the Buffer -> Uint8Array migration.
//
// The dangerous part is that the old code FAILED SILENTLY on a Uint8Array:
//   buf.indexOf(Buffer.from('\r\n\r\n'))  ->  arg coerced to NaN  ->  -1
//   buf.subarray(a, b).toString('utf8')   ->  "71,69,84,..." via Array#toString
// Neither throws. The first hangs every request forever with no log line. The
// split-across-parts case below is exactly what a hand-rolled scan can get
// wrong, so it is the highest-value assertion in this file.

const test = require('node:test');
const assert = require('node:assert/strict');

const { ByteQueue } = require('../src/vless.js');
const {
  indexOfHeaderEnd, parseRequestHead, getAcceptKey
} = require('../src/node/http.js');

const bytes = (s) => Buffer.from(s, 'utf8');

test('indexOfHeaderEnd finds the terminator in a contiguous buffer', () => {
  const buf = bytes('GET / HTTP/1.1\r\nHost: x\r\n\r\nbody');
  const at = indexOfHeaderEnd(buf);
  assert.equal(at, buf.indexOf('\r\n\r\n'));
  assert.equal(buf.subarray(at, at + 4).toString(), '\r\n\r\n');
});

test('indexOfHeaderEnd works on a Uint8Array, not just a Buffer', () => {
  const u8 = Uint8Array.from(bytes('GET / HTTP/1.1\r\n\r\n'));
  assert.ok(!Buffer.isBuffer(u8));
  assert.equal(indexOfHeaderEnd(u8), 'GET / HTTP/1.1'.length);
});

test('indexOfHeaderEnd finds a terminator split across ByteQueue parts', () => {
  // The regression that would silently hang every request: the four bytes
  // straddle a chunk boundary, so any per-part scan misses them.
  const full = 'GET / HTTP/1.1\r\nHost: x\r\n\r\n';
  const expected = bytes(full).indexOf('\r\n\r\n');

  for (let cut = 1; cut < full.length; cut++) {
    const q = new ByteQueue();
    q.push(Uint8Array.from(bytes(full.slice(0, cut))));
    q.push(Uint8Array.from(bytes(full.slice(cut))));
    assert.equal(indexOfHeaderEnd(q.flatten()), expected, `split at ${cut}`);
  }
});

test('indexOfHeaderEnd returns -1 while the head is incomplete', () => {
  assert.equal(indexOfHeaderEnd(bytes('GET / HTTP/1.1\r\nHost: x\r\n')), -1);
  assert.equal(indexOfHeaderEnd(bytes('')), -1);
  assert.equal(indexOfHeaderEnd(bytes('\r\n\r')), -1);
});

test('indexOfHeaderEnd does not accept a bare LF LF', () => {
  // \n\n is not a valid HTTP head terminator; matching it would let a
  // malformed request through with a mis-sliced head.
  assert.equal(indexOfHeaderEnd(bytes('GET / HTTP/1.1\n\nbody')), -1);
});

test('indexOfHeaderEnd honours the from offset', () => {
  const buf = bytes('a\r\n\r\nb\r\n\r\n');
  assert.equal(indexOfHeaderEnd(buf, 0), 1);
  assert.equal(indexOfHeaderEnd(buf, 2), 6);
});

test('parseRequestHead splits the request line and lowercases header names', () => {
  const req = parseRequestHead(bytes(
    'GET /socket HTTP/1.1\r\nHost: example.com\r\nUpgrade: WebSocket\r\n' +
    'Sec-WebSocket-Key: abc==\r\n\r\n'
  ));

  assert.equal(req.method, 'GET');
  assert.equal(req.path, '/socket');
  assert.equal(req.basePath, '/socket');
  assert.equal(req.query, '');
  assert.equal(req.headers.host, 'example.com');
  assert.equal(req.headers.upgrade, 'WebSocket', 'values keep their case');
  assert.equal(req.headers['sec-websocket-key'], 'abc==');
});

test('parseRequestHead separates basePath from the query string', () => {
  const req = parseRequestHead(bytes('GET /admin-stats?token=s3cret&x=1 HTTP/1.1\r\n\r\n'));
  assert.equal(req.basePath, '/admin-stats');
  assert.equal(req.query, 'token=s3cret&x=1');
  assert.equal(new URLSearchParams(req.query).get('token'), 's3cret');
});

test('parseRequestHead handles a query with no value and an empty query', () => {
  assert.equal(parseRequestHead(bytes('GET /p? HTTP/1.1\r\n\r\n')).query, '');
  assert.equal(parseRequestHead(bytes('GET /p? HTTP/1.1\r\n\r\n')).basePath, '/p');
});

test('parseRequestHead ignores lines without a colon', () => {
  const req = parseRequestHead(bytes('GET / HTTP/1.1\r\nnonsense\r\nHost: y\r\n\r\n'));
  assert.equal(req.headers.host, 'y');
  assert.equal(Object.keys(req.headers).length, 1);
});

test('parseRequestHead ignores a leading-colon line rather than making an empty key', () => {
  const req = parseRequestHead(bytes('GET / HTTP/1.1\r\n:folded\r\nHost: y\r\n\r\n'));
  assert.deepEqual(Object.keys(req.headers), ['host']);
});

test('parseRequestHead decodes UTF-8 header values', () => {
  const req = parseRequestHead(bytes('GET / HTTP/1.1\r\nHost: xn--bcher-kva.example\r\nX-T: café\r\n\r\n'));
  assert.equal(req.headers['x-t'], 'café');
});

test('parseRequestHead returns null on a missing or partial request line', () => {
  assert.equal(parseRequestHead(bytes('')), null);
  assert.equal(parseRequestHead(bytes('GET\r\n\r\n')), null);
});

test('getAcceptKey matches the RFC 6455 worked example', () => {
  assert.equal(getAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});
