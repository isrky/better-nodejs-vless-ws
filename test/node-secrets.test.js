'use strict';

// The Node runtime decrypt hook.
//
// decryptSecrets must be a NO-OP when no keys are set or the file is absent —
// that is what lets every existing test (which passes a key-less env and has no
// committed file) keep behaving exactly as before. With a key it fills in that
// group's fields, and an explicit env var still overrides.

const test = require('node:test');
const assert = require('node:assert/strict');

const secrets = require('../src/node/secrets.js');
let ce;

test.before(async () => {
  ce = await import('../tools/credsecrets.mjs');
});

function fixture(keys) {
  const store = { version: 1, credentials: {
    UUID: '00000000-0000-4000-8000-000000000001',
    WSPATH: '/ws',
    ADMIN_TOKEN: 'a'.repeat(64),
    PROVISION_SECRET: 'b'.repeat(64),
    USERS: 'alice bob',
    PROXYIP: '1.2.3.4'
  } };
  return ce.encryptStore(store, keys);
}

test('with no keys and no file it returns an empty object', () => {
  assert.deepEqual(secrets.decryptSecrets({}, null), {});
  assert.deepEqual(secrets.decryptSecrets({ SECRETS_KEY_COMMON: 'x' }, null), {});
});

test('with no keys but a present file it still returns empty (nothing to decrypt)', () => {
  const keys = ce.generateKeys();
  assert.deepEqual(secrets.decryptSecrets({}, fixture(keys)), {});
});

test('a group key decrypts exactly that group', () => {
  const keys = ce.generateKeys();
  const file = fixture(keys);

  const common = secrets.decryptSecrets({ SECRETS_KEY_COMMON: keys.common }, file);
  assert.deepEqual(common, { UUID: '00000000-0000-4000-8000-000000000001', WSPATH: '/ws' });
  assert.equal('ADMIN_TOKEN' in common, false, 'no server key, no server fields');

  const server = secrets.decryptSecrets({ SECRETS_KEY_SERVER: keys.server }, file);
  assert.deepEqual(Object.keys(server).sort(), ['ADMIN_TOKEN', 'PROVISION_SECRET', 'USERS']);
});

test('a deployment with both its keys gets both groups', () => {
  const keys = ce.generateKeys();
  const file = fixture(keys);
  const flyEnv = { SECRETS_KEY_COMMON: keys.common, SECRETS_KEY_SERVER: keys.server };
  const got = secrets.decryptSecrets(flyEnv, file);
  assert.equal(got.UUID, '00000000-0000-4000-8000-000000000001');
  assert.equal(got.ADMIN_TOKEN, 'a'.repeat(64));
  assert.equal('PROXYIP' in got, false, 'fly holds no edge key');
});

test('a wrong key fails that group closed (empty), not a crash', () => {
  const keys = ce.generateKeys();
  const file = fixture(keys);
  const wrong = ce.generateKeys().common;
  // capture the stderr note without failing the test
  const original = process.stderr.write;
  let warned = '';
  process.stderr.write = (s) => { warned += s; return true; };
  try {
    const got = secrets.decryptSecrets({ SECRETS_KEY_COMMON: wrong }, file);
    assert.deepEqual(got, {}, 'a bad key yields no fields, not garbage');
  } finally {
    process.stderr.write = original;
  }
  assert.match(warned, /could not decrypt the "common" group/);
});

test('loadConfig merges decrypted secrets, and an explicit env var overrides', async () => {
  const config = require('../src/node/config.js');
  const keys = ce.generateKeys();
  const file = fixture(keys);

  // Inject the fixture file through decryptSecrets by pre-decrypting into env,
  // exactly as loadConfig will once the committed file exists. loadConfig's own
  // decryptSecrets(env) sees no committed file in the test tree, so we hand it
  // the already-merged values plus a key-less env to prove the merge/override.
  const decrypted = secrets.decryptSecrets({ SECRETS_KEY_COMMON: keys.common }, file);
  assert.equal(decrypted.UUID, '00000000-0000-4000-8000-000000000001');

  const merged = config.loadConfig({ ...decrypted });
  assert.equal(merged.uuid, '00000000-0000-4000-8000-000000000001', 'decrypted UUID is used');

  const overridden = config.loadConfig({ ...decrypted, UUID: '00000000-0000-4000-8000-000000000002' });
  assert.equal(overridden.uuid, '00000000-0000-4000-8000-000000000002', 'explicit env wins');
});

test('loadConfig fails closed when a group key is set but UUID did not decrypt', () => {
  const config = require('../src/node/config.js');

  // A key is set, but the committed file in the test tree carries no matching
  // decryptable UUID → refuse the published-default fallback rather than run as
  // an open proxy on a well-known credential.
  assert.throws(
    () => config.loadConfig({ SECRETS_KEY_COMMON: 'not-a-real-key' }),
    /refusing to fall back to the published default/
  );

  // An explicit UUID opts out of the guard (honoured above the fallback).
  const ok = config.loadConfig({
    SECRETS_KEY_COMMON: 'not-a-real-key',
    UUID: '00000000-0000-4000-8000-000000000002'
  });
  assert.equal(ok.uuid, '00000000-0000-4000-8000-000000000002');

  // With no key set at all, the zero-config default still works (unchanged).
  assert.equal(config.loadConfig({}).uuid.length, 36, 'default UUID path intact');
});
