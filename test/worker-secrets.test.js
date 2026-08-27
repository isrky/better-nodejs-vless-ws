'use strict';

// The Worker/Deno decrypt path (Web Crypto). Exercised in Node, where
// crypto.subtle and atob are the same globals these runtimes expose.

const test = require('node:test');
const assert = require('node:assert/strict');

let ws;   // src/worker/secrets.mjs
let ce;   // the tool, to produce a real cipher

test.before(async () => {
  ws = await import('../src/worker/secrets.mjs');
  ce = await import('../tools/credsecrets.mjs');
});

function fixture(keys) {
  const store = { version: 1, credentials: {
    UUID: '00000000-0000-4000-8000-000000000001',
    WSPATH: '/ws',
    PROXYIP: '1.2.3.4'
  } };
  return ce.encryptStore(store, keys);
}

test('decryptGroups is empty with no keys, and per-group with a key', async () => {
  const keys = ce.generateKeys();
  const cipher = fixture(keys);

  assert.deepEqual(await ws.decryptGroups({}, cipher), {}, 'no keys, nothing');

  const edge = await ws.decryptGroups({ SECRETS_KEY_EDGE: keys.edge }, cipher);
  assert.deepEqual(edge, { PROXYIP: '1.2.3.4' });

  const both = await ws.decryptGroups(
    { SECRETS_KEY_COMMON: keys.common, SECRETS_KEY_EDGE: keys.edge }, cipher
  );
  assert.equal(both.UUID, '00000000-0000-4000-8000-000000000001');
  assert.equal(both.WSPATH, '/ws');
  assert.equal(both.PROXYIP, '1.2.3.4');
});

test('a wrong key fails that group closed, not a throw', async () => {
  const keys = ce.generateKeys();
  const cipher = fixture(keys);
  const original = console.warn;
  console.warn = () => {};
  try {
    const got = await ws.decryptGroups({ SECRETS_KEY_COMMON: ce.generateKeys().common }, cipher);
    assert.deepEqual(got, {}, 'bad key yields nothing');
  } finally {
    console.warn = original;
  }
});

test('ensureSecrets caches once and secretValue reads it; empty file is a no-op', async () => {
  const keys = ce.generateKeys();
  const cipher = fixture(keys);

  ws._resetForTest();
  await ws.ensureSecrets({ SECRETS_KEY_COMMON: keys.common }, cipher);
  assert.equal(ws.secretValue('UUID'), '00000000-0000-4000-8000-000000000001');
  assert.equal(ws.secretValue('PROXYIP'), undefined, 'no edge key, no PROXYIP');

  // second call with different args is ignored (one-shot per isolate)
  await ws.ensureSecrets({ SECRETS_KEY_EDGE: keys.edge }, cipher);
  assert.equal(ws.secretValue('PROXYIP'), undefined, 'cache is not rebuilt');

  ws._resetForTest();
  await ws.ensureSecrets({}, { v: 1, groups: {} });
  assert.equal(ws.secretValue('UUID'), undefined, 'empty file leaves everything to env');
});

test('the config accessors prefer a decrypted value, else fall back to env', async () => {
  const config = await import('../src/worker/config.mjs');
  const keys = ce.generateKeys();
  const cipher = fixture(keys);

  ws._resetForTest();
  await ws.ensureSecrets({}, { v: 1, groups: {} });   // no secrets → env fallback
  assert.equal(config.getWsPath({ WSPATH: '/from-env' }), '/from-env');
  assert.equal(config.getProxyIp({ PROXYIP: '9.9.9.9' }), '9.9.9.9');

  ws._resetForTest();
  await ws.ensureSecrets({ SECRETS_KEY_COMMON: keys.common }, cipher);
  assert.equal(config.getWsPath({ WSPATH: '/ignored' }), '/ws', 'decrypted WSPATH wins over env');
});
