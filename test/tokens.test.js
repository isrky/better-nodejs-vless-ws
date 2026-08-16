'use strict';

// The signing layer. Two properties carry most of the weight here:
//
//   * forged input must be indistinguishable from garbage — it gets the decoy,
//     so a probe cannot learn the endpoint exists;
//   * the MAC is verified BEFORE anything is parsed, so no Number(), split() or
//     lookup is reachable from unsigned input.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  constantTimeEqual, tokensMatch, subkey, sign,
  mintSession, verifySession, mintInvite, verifyInvite, createBurnStore
} = require('../src/node/tokens.js');

const MASTER = 'a-master-secret-that-is-long-enough';
const KEY = subkey(MASTER, 'invite-key-v1');
const SKEY = subkey(MASTER, 'adm-session-v1');

const at = (seconds) => () => seconds * 1000;

test('constantTimeEqual matches only identical strings', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('ab', 'abc'), false, 'unequal lengths must not throw');
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual(null, 'abc'), false);
  assert.equal(constantTimeEqual('abc', undefined), false);
});

test('tokensMatch rejects an unset expected token', () => {
  assert.equal(tokensMatch('anything', ''), false, 'unset ADMIN_TOKEN must never match');
  assert.equal(tokensMatch('', ''), false);
  assert.equal(tokensMatch('s3cret', 's3cret'), true);
  assert.equal(tokensMatch(null, 's3cret'), false);
});

test('subkeys are deterministic and domain-separated', () => {
  assert.deepEqual(subkey(MASTER, 'a'), subkey(MASTER, 'a'));
  assert.notDeepEqual(subkey(MASTER, 'a'), subkey(MASTER, 'b'));
  assert.notDeepEqual(subkey(MASTER, 'a'), subkey(MASTER + 'x', 'a'));
  assert.equal(subkey(MASTER, 'a').length, 32);
});

test('a signature is 22 base64url chars and tag-separated', () => {
  const mac = sign(KEY, 'tag-a', 'body');
  assert.equal(mac.length, 22);
  assert.match(mac, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(sign(KEY, 'tag-b', 'body'), mac, 'a different tag must not collide');
});

// ---------- invites ----------

test('a fresh invite round-trips', () => {
  const { token, exp, nonce } = mintInvite(KEY, 'alice', 900, 'nonce123', at(1000));
  const r = verifyInvite(KEY, token, at(1000));

  assert.equal(r.ok, true);
  assert.equal(r.label, 'alice');
  assert.equal(r.nonce, 'nonce123');
  assert.equal(r.exp, exp);
  assert.equal(exp, 1900);
  assert.equal(nonce, 'nonce123');
});

test('every kind of tampering reads as forged, never stale', () => {
  const { token } = mintInvite(KEY, 'alice', 900, 'nonce123', at(1000));
  const [ver, exp, label, nonce, mac] = token.split('.');

  const tampered = [
    token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'),   // last mac char
    `${ver}.${exp}.bob.${nonce}.${mac}`,                       // swapped label
    `${ver}.999999999.${label}.${nonce}.${mac}`,               // extended expiry
    `2.${exp}.${label}.${nonce}.${mac}`,                       // wrong version
    `${ver}.${exp}.${label}.${nonce}`,                         // mac stripped
    token.slice(0, 12),                                        // truncated
    '',
    'garbage',
    'a.b.c.d.e',
    '.'.repeat(40),
    'x'.repeat(300)                                            // over the length cap
  ];

  for (const bad of tampered) {
    const r = verifyInvite(KEY, bad, at(1000));
    assert.equal(r.ok, false, JSON.stringify(bad).slice(0, 40));
    assert.equal(r.reason, 'forged', `must be forged, not stale: ${JSON.stringify(bad).slice(0, 40)}`);
  }
});

test('a token signed with a different key is forged', () => {
  const { token } = mintInvite(subkey('other-master', 'invite-key-v1'), 'alice', 900, 'n', at(1000));
  assert.equal(verifyInvite(KEY, token, at(1000)).reason, 'forged');
});

test('a valid but expired invite is stale, and still resolves its label', () => {
  const { token } = mintInvite(KEY, 'alice', 900, 'nonce123', at(1000));

  assert.equal(verifyInvite(KEY, token, at(1899)).ok, true, 'still fresh one second before');

  const r = verifyInvite(KEY, token, at(1901));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'stale');
  assert.equal(r.label, 'alice', 'the MAC proved the operator minted it, so the label is trusted');
  assert.equal(r.nonce, 'nonce123');
});

test('expiry is exclusive at the boundary', () => {
  const { token } = mintInvite(KEY, 'alice', 900, 'n', at(1000));
  assert.equal(verifyInvite(KEY, token, at(1900)).reason, 'stale', 'exp is not still valid');
});

test('a malformed body with a VALID mac is forged, not a parse error', () => {
  // The parser must be unreachable from unsigned input, and reachable-but-junk
  // signed input must land in exactly the same bucket as a bad signature.
  for (const body of ['1.notanumber.alice.n', '1.1900.alice', '1.1900.alice.n.extra', '9.1900.a.n']) {
    const token = body + '.' + sign(KEY, 'invite-v1', body);
    const r = verifyInvite(KEY, token, at(1000));
    assert.equal(r.ok, false, body);
    assert.equal(r.reason, 'forged', body);
  }
});

test('an empty label or nonce is forged', () => {
  for (const body of ['1.1900..nonce', '1.1900.alice.']) {
    const token = body + '.' + sign(KEY, 'invite-v1', body);
    assert.equal(verifyInvite(KEY, token, at(1000)).reason, 'forged', body);
  }
});

test('an invite token stays short enough for a sparse QR', () => {
  const { token } = mintInvite(KEY, 'a'.repeat(32), 900, 'abcdefgh', at(1786000000));
  const url = 'https://edge.isrky.dev/i/' + token;
  assert.ok(url.length < 130, `invite URL is ${url.length} chars`);
});

// ---------- sessions ----------

test('a session round-trips and expires', () => {
  const value = mintSession(SKEY, 43200, at(1000));
  assert.equal(verifySession(SKEY, value, at(1000)), true);
  assert.equal(verifySession(SKEY, value, at(44199)), true);
  assert.equal(verifySession(SKEY, value, at(44201)), false);
});

test('a session is rejected under a different key or when tampered', () => {
  const value = mintSession(SKEY, 43200, at(1000));

  assert.equal(verifySession(subkey('other', 'adm-session-v1'), value, at(1000)), false);
  assert.equal(verifySession(SKEY, value.slice(0, -1) + 'A', at(1000)), false);
  assert.equal(verifySession(SKEY, '1.99999999999.' + value.split('.')[2], at(1000)), false);
  assert.equal(verifySession(SKEY, '', at(1000)), false);
  assert.equal(verifySession(SKEY, undefined, at(1000)), false);
  assert.equal(verifySession(SKEY, 'x'.repeat(200), at(1000)), false);
});

test('the session value never contains the admin token', () => {
  // The cookie carries a signed assertion, not the credential itself, so a
  // cookie lifted from a device backup cannot be replayed as ?token=.
  const key = subkey('s3cret-admin-token', 'adm-session-v1');
  const value = mintSession(key, 43200, at(1000));
  assert.ok(!value.includes('s3cret-admin-token'));
  assert.ok(!value.includes('s3cret'));
});

// ---------- burn store ----------

test('a claim burns, but a refresh inside the grace window still works', () => {
  const burn = createBurnStore();
  const expiresAt = 10_000_000;

  assert.equal(burn.claim('n1', expiresAt, 300_000, 1_000_000), true, 'first use');
  assert.equal(burn.claim('n1', expiresAt, 300_000, 1_100_000), true, 'refresh inside grace');
  assert.equal(burn.claim('n1', expiresAt, 300_000, 1_400_000), false, 'past the grace window');
});

test('distinct nonces are independent', () => {
  const burn = createBurnStore();
  assert.equal(burn.claim('a', 10_000_000, 1000, 1_000_000), true);
  assert.equal(burn.claim('b', 10_000_000, 1000, 1_000_000), true);
  assert.equal(burn.size, 2);
});

test('expired entries are swept once the store fills', () => {
  const burn = createBurnStore({ max: 3 });
  burn.claim('a', 2000, 100, 1000);
  burn.claim('b', 2000, 100, 1000);
  burn.claim('c', 9_000_000, 100, 1000);
  assert.equal(burn.size, 3);

  // 'a' and 'b' are past their expiry by now, so the sweep makes room.
  assert.equal(burn.claim('d', 9_000_000, 100, 5000), true);
  assert.ok(burn.size <= 3);
});

test('a full store of live entries fails closed', () => {
  const burn = createBurnStore({ max: 2 });
  burn.claim('a', 9_000_000, 100, 1000);
  burn.claim('b', 9_000_000, 100, 1000);
  assert.equal(burn.claim('c', 9_000_000, 100, 1000), false, 'must refuse rather than grow');
  assert.equal(burn.size, 2);
});
