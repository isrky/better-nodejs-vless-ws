'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDnsCache } = require('../src/node/dnscache.js');

/** A dgram-shaped double that records what it was asked to send. */
function fakeSocket() {
  const sent = [];
  return {
    sent,
    send(payload, port, address, cb) {
      sent.push({ payload: Buffer.from(payload).toString(), port, address });
      if (cb) cb(null);
    }
  };
}

/** A resolver double whose answers are controlled per-host. */
function fakeResolver(answers = {}) {
  const calls = [];
  const inflight = [];
  return {
    calls,
    inflight,
    resolve4(host, cb) {
      calls.push(host);
      const answer = answers[host];
      if (answer === 'defer') return inflight.push({ host, cb });
      queueMicrotask(() => (answer ? cb(null, answer) : cb(new Error('NXDOMAIN'))));
    }
  };
}

const quiet = () => {};
const settle = () => new Promise((r) => setTimeout(r, 5));

test('an IPv4 literal bypasses the resolver entirely', () => {
  const resolver = fakeResolver();
  const dns = createDnsCache({ resolver, logger: quiet });
  const sock = fakeSocket();

  dns.resolveAndSend(sock, Buffer.from('x'), 53, '1.1.1.1', () => {});

  assert.equal(resolver.calls.length, 0);
  assert.equal(sock.sent[0].address, '1.1.1.1');
  dns.stop();
});

test('an IPv6 literal bypasses the resolver too', () => {
  const resolver = fakeResolver();
  const dns = createDnsCache({ resolver, logger: quiet });
  const sock = fakeSocket();

  dns.resolveAndSend(sock, Buffer.from('x'), 53, '2606:4700::1111', () => {});

  assert.equal(resolver.calls.length, 0);
  assert.equal(sock.sent[0].address, '2606:4700::1111');
  dns.stop();
});

test('an empty host reports an error rather than sending', () => {
  const dns = createDnsCache({ resolver: fakeResolver(), logger: quiet });
  const sock = fakeSocket();

  let err = null;
  dns.resolveAndSend(sock, Buffer.from('x'), 53, '', (e) => { err = e; });

  assert.equal(err, 'Empty Host');
  assert.equal(sock.sent.length, 0);
  dns.stop();
});

test('a resolved host is cached, so the second send does not look it up', async () => {
  const resolver = fakeResolver({ 'example.com': ['93.184.216.34'] });
  const dns = createDnsCache({ resolver, logger: quiet });
  const sock = fakeSocket();

  dns.resolveAndSend(sock, Buffer.from('one'), 80, 'example.com', () => {});
  await settle();

  dns.resolveAndSend(sock, Buffer.from('two'), 80, 'example.com', () => {});

  assert.equal(resolver.calls.length, 1, 'one lookup for two sends');
  assert.deepEqual(sock.sent.map((s) => s.payload), ['one', 'two']);
  assert.deepEqual(sock.sent.map((s) => s.address), ['93.184.216.34', '93.184.216.34']);
  assert.equal(dns.size, 1);
  dns.stop();
});

test('concurrent sends to one cold host share a single lookup', async () => {
  const resolver = fakeResolver({ 'slow.example': 'defer' });
  const dns = createDnsCache({ resolver, logger: quiet });
  const sock = fakeSocket();

  dns.resolveAndSend(sock, Buffer.from('a'), 80, 'slow.example', () => {});
  dns.resolveAndSend(sock, Buffer.from('b'), 80, 'slow.example', () => {});
  dns.resolveAndSend(sock, Buffer.from('c'), 80, 'slow.example', () => {});

  assert.equal(resolver.calls.length, 1, 'coalesced into one lookup');
  assert.equal(sock.sent.length, 0, 'nothing sent while it is in flight');

  resolver.inflight[0].cb(null, ['10.0.0.1']);

  assert.deepEqual(sock.sent.map((s) => s.payload), ['a', 'b', 'c'],
    'the whole queue flushes in order');
  dns.stop();
});

test('a failed lookup reports the error to every queued caller', () => {
  const resolver = fakeResolver({ 'bad.example': 'defer' });
  const dns = createDnsCache({ resolver, logger: quiet });
  const sock = fakeSocket();

  const errors = [];
  dns.resolveAndSend(sock, Buffer.from('a'), 80, 'bad.example', (e) => errors.push(e));
  dns.resolveAndSend(sock, Buffer.from('b'), 80, 'bad.example', (e) => errors.push(e));

  resolver.inflight[0].cb(new Error('SERVFAIL'));

  assert.equal(errors.length, 2);
  assert.equal(sock.sent.length, 0);
  assert.equal(dns.size, 0, 'a failure is not cached');
  dns.stop();
});

test('an entry expires once its TTL has passed', async () => {
  let t = 1_000_000;
  const resolver = fakeResolver({ 'ttl.example': ['10.0.0.9'] });
  const dns = createDnsCache({ resolver, logger: quiet, ttl: 10, now: () => t });
  const sock = fakeSocket();

  dns.resolveAndSend(sock, Buffer.from('a'), 80, 'ttl.example', () => {});
  await settle();
  assert.equal(resolver.calls.length, 1);

  t += 5_000;                       // still inside the TTL
  dns.resolveAndSend(sock, Buffer.from('b'), 80, 'ttl.example', () => {});
  assert.equal(resolver.calls.length, 1, 'served from cache');

  t += 20_000;                      // past it
  dns.resolveAndSend(sock, Buffer.from('c'), 80, 'ttl.example', () => {});
  assert.equal(resolver.calls.length, 2, 're-resolved after expiry');
  dns.stop();
});

test('clear() drops the cache', async () => {
  const resolver = fakeResolver({ 'x.example': ['10.0.0.1'] });
  const dns = createDnsCache({ resolver, logger: quiet });

  dns.resolveAndSend(fakeSocket(), Buffer.from('a'), 80, 'x.example', () => {});
  await settle();
  assert.equal(dns.size, 1);

  dns.clear();
  assert.equal(dns.size, 0);
  dns.stop();
});

test('the sweep timer is unref\'d, so it never holds the process open', () => {
  const dns = createDnsCache({ resolver: fakeResolver(), logger: quiet });
  // If this timer were ref'd, `node --test` itself would never exit — the whole
  // suite completing is the assertion. stop() is still the tidy path.
  assert.doesNotThrow(() => dns.stop());
});
