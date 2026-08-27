'use strict';

// The encryption tool: store -> committed file -> back.
//
// This is the only place encryption happens; the runtime builds only decrypt.
// The format contract (AES-256-GCM, per-value IV, tag appended to ciphertext)
// is exercised here against the tool's own decrypt, and against BOTH runtime
// decrypters in test/secrets-interop.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let ce;
let cs;

test.before(async () => {
  ce = await import('../tools/credsecrets.mjs');
  cs = await import('../tools/credstore.mjs');
});

function fullStore() {
  const store = cs.emptyStore();
  Object.assign(store.credentials, {
    UUID: '00000000-0000-4000-8000-000000000001',
    WSPATH: '/test-ws-path',
    ADMIN_TOKEN: 'a'.repeat(64),
    PROVISION_SECRET: 'b'.repeat(64),
    PROVISION_SECRET_PREVIOUS: 'c'.repeat(64),
    USERS: 'alice bob',
    PROXYIP: '1.2.3.4',
    // render-only / per-deployment config that must NOT be encrypted:
    FLY_HOST: 'fly.example.dev',
    WORKER_HOST: 'worker.example.dev'
  });
  return store;
}

test('the group partition matches the fields pushTo audiences', () => {
  // The encrypted grouping is a hand-made design decision; this guards it from
  // drifting away from where each secret is actually needed.
  const audience = (targets) => {
    const t = new Set(targets);
    if (['fly', 'wrangler', 'deno', 'docker'].every((x) => t.has(x))) return 'common';
    if (t.has('fly') && t.has('docker') && !t.has('wrangler')) return 'server';
    if (t.has('wrangler') && t.has('deno') && !t.has('fly')) return 'edge';
    return null;
  };
  for (const [group, keys] of Object.entries(cs.GROUPS)) {
    for (const key of keys) {
      const f = cs.field(key);
      assert.ok(f, `${key} is a real field`);
      assert.equal(audience(f.pushTo), group, `${key} belongs to the ${group} group`);
    }
  }
});

test('generateKeys makes one 32-byte base64 key per group', () => {
  const keys = ce.generateKeys();
  assert.deepEqual(Object.keys(keys).sort(), Object.keys(cs.GROUPS).sort());
  for (const [group, b64] of Object.entries(keys)) {
    assert.equal(Buffer.from(b64, 'base64').length, 32, `${group} key is 32 bytes`);
  }
  const again = ce.generateKeys();
  assert.notEqual(again.common, keys.common, 'keys are random');
});

test('encryptStore -> decryptSecretsFile round-trips every set field', () => {
  const store = fullStore();
  const keys = ce.generateKeys();
  const file = ce.encryptStore(store, keys);
  const back = ce.decryptSecretsFile(file, keys);

  for (const group of Object.keys(cs.GROUPS)) {
    for (const field of cs.GROUPS[group]) {
      assert.equal(back[field], store.credentials[field], `${field} round-trips`);
    }
  }
  // render-only / per-deployment config is never encrypted
  assert.equal('FLY_HOST' in back, false, 'render inputs are not encrypted');
  assert.equal('WORKER_HOST' in back, false);
});

test('only fields that are set appear in the file', () => {
  const store = cs.emptyStore();
  store.credentials.UUID = '00000000-0000-4000-8000-000000000001';
  store.credentials.WSPATH = '/x';
  // no server or edge fields set
  const file = ce.encryptStore(store, ce.generateKeys());
  assert.deepEqual(Object.keys(file.groups.common).sort(), ['UUID', 'WSPATH']);
  assert.equal('server' in file.groups, false, 'an all-unset group is omitted');
  assert.equal('edge' in file.groups, false);
});

test('a wrong key fails to decrypt (GCM authentication)', () => {
  const store = fullStore();
  const file = ce.encryptStore(store, ce.generateKeys());
  const wrong = ce.generateKeys();
  assert.throws(() => ce.decryptSecretsFile(file, wrong), /unable to authenticate|bad decrypt|auth/i);
});

test('the committed file never contains a plaintext secret', () => {
  const store = cs.emptyStore();
  for (const group of Object.keys(cs.GROUPS)) {
    for (const field of cs.GROUPS[group]) store.credentials[field] = `SENTINEL-${field}-VALUE`;
  }
  const file = ce.encryptStore(store, ce.generateKeys());
  const text = JSON.stringify(file);
  for (const group of Object.keys(cs.GROUPS)) {
    for (const field of cs.GROUPS[group]) {
      assert.ok(!text.includes(`SENTINEL-${field}-VALUE`), `${field} leaked into the file`);
      assert.ok(text.includes(`"${field}"`), `${field} is present by name`);
    }
  }
});

test('the keyring writes 0600 and round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyring-'));
  const p = path.join(dir, 'secrets.keys.json');
  const keys = ce.generateKeys();
  ce.writeKeyring(keys, p);

  assert.equal((fs.statSync(p).mode & 0o777).toString(8), '600', 'keyring is 0600');
  assert.deepEqual(ce.readKeyring(p), keys);
  assert.equal(ce.readKeyring(path.join(dir, 'nope.json')), null, 'absent keyring reads as null');
});

test('the secrets file writes as a normal tracked file (not 0600) and reads back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encfile-'));
  const p = path.join(dir, 'secrets.enc.json');
  const keys = ce.generateKeys();
  const file = ce.encryptStore(fullStore(), keys);
  ce.writeSecretsFile(file, p);

  // committed file must be readable by others (git/CI), unlike the 0600 keyring
  assert.notEqual((fs.statSync(p).mode & 0o004), 0, 'world-readable, it is committed ciphertext');
  assert.deepEqual(ce.readSecretsFile(p), file);
});

test('platformKeys hands each platform exactly its two group keys', () => {
  const keys = ce.generateKeys();
  const fly = ce.platformKeys('fly', keys);
  assert.deepEqual(fly.map((k) => k.group), ['common', 'server']);
  assert.deepEqual(fly.map((k) => k.envName), ['SECRETS_KEY_COMMON', 'SECRETS_KEY_SERVER']);
  assert.equal(fly[0].value, keys.common);

  const worker = ce.platformKeys('wrangler', keys);
  assert.deepEqual(worker.map((k) => k.group), ['common', 'edge']);
});
