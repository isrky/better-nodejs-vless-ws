'use strict';

// The DoH resolver.
//
// The transport is injected, so none of this touches the network or needs TLS
// fixtures — the same seam dnscache.js already uses for its resolver.
//
// The fallback tests matter more than the happy path: every tunnelled
// destination resolves through here, so a resolver outage that is not survived
// takes down the whole service.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDohResolver, encodeQuery, decodeAnswer } = require('../src/node/doh.js');

/** Build an answer the way a real server does — with a compression pointer. */
function answer(addresses, { rcode = 0, type = 1 } = {}) {
  const name = Buffer.from([7, ...Buffer.from('example'), 3, ...Buffer.from('com'), 0]);
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0x8180, 2);
  head[3] = (head[3] & 0xf0) | rcode;
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(addresses.length, 6);

  const records = addresses.map((a) => {
    const rr = Buffer.alloc(12 + 4);
    rr.writeUInt16BE(0xc00c, 0);          // pointer back to the question's name
    rr.writeUInt16BE(type, 2);
    rr.writeUInt16BE(1, 4);
    rr.writeUInt32BE(300, 6);
    rr.writeUInt16BE(4, 10);
    Buffer.from(a.split('.').map(Number)).copy(rr, 12);
    return rr;
  });

  const question = Buffer.concat([name, Buffer.from([0, 1, 0, 1])]);
  return Buffer.concat([head, question, ...records]);
}

const okTransport = (addresses) => (query, cb) => cb(null, answer(addresses));
const failTransport = (message) => (query, cb) => cb(new Error(message));

function resolver(over = {}) {
  return createDohResolver({
    url: 'https://dns.example/dns-query',
    logger: () => {},
    fallback: { resolve4: (h, cb) => cb(null, ['9.9.9.9']) },
    ...over
  });
}

// ---------- wire format ----------

test('the encoder produces the query the endpoint accepted', () => {
  // Pinned against a query verified by hand against the live resolver, so a
  // refactor cannot quietly produce something only some servers tolerate.
  const b64 = encodeQuery('example.com').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(b64, 'AAABAAABAAAAAAAAB2V4YW1wbGUDY29tAAABAAE');
});

test('the encoder sets recursion desired and exactly one question', () => {
  const q = encodeQuery('a.b.example.com');
  assert.equal(q.readUInt16BE(0), 0, 'id 0 keeps the GET cacheable');
  assert.equal(q.readUInt16BE(2), 0x0100);
  assert.equal(q.readUInt16BE(4), 1);
});

test('the decoder follows compression pointers and collects every A record', () => {
  assert.deepEqual(decodeAnswer(answer(['1.2.3.4', '5.6.7.8'])), ['1.2.3.4', '5.6.7.8']);
});

test('the decoder skips records that are not A', () => {
  // A CNAME chain puts non-A records ahead of the addresses; taking rdata from
  // one blindly would yield a bogus IP that fails much later, at connect time.
  assert.deepEqual(decodeAnswer(answer(['1.2.3.4'], { type: 5 })), []);
});

test('the decoder rejects a non-zero rcode and a truncated message', () => {
  assert.throws(() => decodeAnswer(answer(['1.2.3.4'], { rcode: 2 })), /rcode 2/);
  assert.throws(() => decodeAnswer(Buffer.alloc(4)), /short message/);
  assert.throws(() => decodeAnswer(answer(['1.2.3.4']).subarray(0, 20)), /truncated|short/);
});

// ---------- the resolve4 contract ----------

test('a successful lookup returns addresses in the node dns shape', (t, done) => {
  resolver({ request: okTransport(['1.2.3.4']) }).resolve4('example.com', (err, addresses) => {
    assert.equal(err, null);
    assert.deepEqual(addresses, ['1.2.3.4']);
    done();
  });
});

// ---------- fallback, one trigger at a time ----------

for (const [name, over] of [
  ['a transport error', { request: failTransport('socket hang up') }],
  ['a timeout', { request: failTransport('timeout') }],
  ['SERVFAIL', { request: (q, cb) => cb(null, answer([], { rcode: 2 })) }],
  ['an empty answer', { request: okTransport([]) }],
  ['a malformed body', { request: (q, cb) => cb(null, Buffer.alloc(3)) }]
]) {
  test(`${name} falls back to the system resolver`, (t, done) => {
    resolver(over).resolve4('example.com', (err, addresses) => {
      assert.equal(err, null, 'the caller must not see the DoH failure');
      assert.deepEqual(addresses, ['9.9.9.9']);
      done();
    });
  });
}

test('a name too malformed to encode falls back without blaming the resolver', (t, done) => {
  const r = resolver({ request: () => assert.fail('must not reach the network') });
  r.resolve4('x'.repeat(64) + '.example', (err, addresses) => {
    assert.deepEqual(addresses, ['9.9.9.9']);
    assert.equal(r.state.consecutiveFailures, 0, 'our own bad input is not a resolver failure');
    done();
  });
});

// ---------- the breaker ----------

test('the breaker opens after consecutive failures and stops calling out', async () => {
  let calls = 0;
  const r = resolver({
    failureThreshold: 3,
    request: (q, cb) => { calls += 1; cb(new Error('down')); }
  });

  const lookup = () => new Promise((res) => r.resolve4('example.com', res));
  for (let i = 0; i < 3; i++) await lookup();
  assert.equal(calls, 3);
  assert.equal(r.state.open, true);

  // Open: an outage costs one timeout, not one per lookup.
  for (let i = 0; i < 5; i++) await lookup();
  assert.equal(calls, 3, 'no further requests while open');
});

test('the breaker closes again after the cool-off', async () => {
  let clock = 1000;
  let calls = 0;
  const r = resolver({
    failureThreshold: 1,
    coolOffMs: 30000,
    now: () => clock,
    request: (q, cb) => { calls += 1; cb(new Error('down')); }
  });

  await new Promise((res) => r.resolve4('example.com', res));
  assert.equal(r.state.open, true);

  clock += 30001;
  assert.equal(r.state.open, false);
  await new Promise((res) => r.resolve4('example.com', res));
  assert.equal(calls, 2, 'it tries again once the cool-off has passed');
});

test('one success clears the failure count', async () => {
  let fail = true;
  const r = resolver({
    failureThreshold: 3,
    request: (q, cb) => (fail ? cb(new Error('down')) : cb(null, answer(['1.2.3.4'])))
  });

  await new Promise((res) => r.resolve4('a.example', res));
  await new Promise((res) => r.resolve4('b.example', res));
  assert.equal(r.state.consecutiveFailures, 2);

  fail = false;
  await new Promise((res) => r.resolve4('c.example', res));
  assert.equal(r.state.consecutiveFailures, 0, 'otherwise a slow drip eventually trips it');
});

// ---------- the recursion guard ----------

test('the transport never routes its own endpoint through this resolver', () => {
  // https.request resolves the endpoint hostname with the system resolver. If
  // anyone ever passes a `lookup` into it, DoH resolves its own host through
  // DoH and every lookup deadlocks on the first one.
  const src = require('fs').readFileSync(require.resolve('../src/node/doh.js'), 'utf8');
  const transport = src.slice(src.indexOf('function httpsTransport'), src.indexOf('* @param {object}   opts'));
  assert.ok(!/\blookup\s*:/.test(transport), 'httpsTransport must not set a lookup option');
});

test('createDohResolver refuses to be built without an endpoint', () => {
  assert.throws(() => createDohResolver({}), /needs a url/);
});
