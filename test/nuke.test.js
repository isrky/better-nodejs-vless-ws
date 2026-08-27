'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let credentials;
let storeTools;
let secretTools;

test.before(async () => {
  [credentials, storeTools, secretTools] = await Promise.all([
    import('../tools/credentials.mjs'),
    import('../tools/credstore.mjs'),
    import('../tools/credsecrets.mjs')
  ]);
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuke-'));
  const storePath = path.join(dir, 'credentials.json');
  const keyringPath = path.join(dir, 'secrets.keys.json');
  const secretsFilePath = path.join(dir, 'secrets.enc.json');
  let store = storeTools.emptyStore();
  for (const [key, value] of Object.entries({
    UUID: '00000000-0000-4000-8000-000000000001',
    WSPATH: '/old-path',
    FLY_HOST: 'fly.example.dev',
    WORKER_HOST: 'worker.example.dev',
    ADMIN_TOKEN: 'old-admin',
    PROVISION_SECRET: 'old-provision'
  })) store = storeTools.withField(store, key, value);
  storeTools.writeStore(storePath, store);
  const keys = secretTools.generateKeys();
  secretTools.writeKeyring(keys, keyringPath);
  secretTools.writeSecretsFile(secretTools.encryptStore(store, keys), secretsFilePath);
  return { dir, store, storePath, keys, keyringPath, secretsFilePath };
}

function rotated(store) {
  let next = storeTools.withField(store, 'UUID', '00000000-0000-4000-8000-000000000002');
  next = storeTools.withField(next, 'WSPATH', '/new-path');
  next = storeTools.withField(next, 'ADMIN_TOKEN', 'new-admin');
  next = storeTools.withField(next, 'PROVISION_SECRET', 'new-provision');
  return storeTools.withField(next, 'PROVISION_SECRET_PREVIOUS', 'old-provision');
}

test('soft nuke keeps the keyring and re-encrypts the canonical payload', () => {
  const f = fixture();
  const next = rotated(f.store);
  const result = credentials.commitCredentialNuke(next, {
    kind: 'soft',
    storePath: f.storePath,
    canonicalStorePath: f.storePath,
    keyringPath: f.keyringPath,
    secretsFilePath: f.secretsFilePath
  });

  assert.deepEqual(secretTools.readKeyring(f.keyringPath), f.keys);
  assert.equal(result.encrypted, true);
  assert.deepEqual(result.keyringGroups.sort(), Object.keys(f.keys).sort());
  const decrypted = secretTools.decryptSecretsFile(
    secretTools.readSecretsFile(f.secretsFilePath), f.keys
  );
  assert.equal(decrypted.UUID, next.credentials.UUID);
  assert.equal(decrypted.PROVISION_SECRET_PREVIOUS, 'old-provision');
  assert.equal(storeTools.readStore(f.storePath + '.bak').credentials.UUID, f.store.credentials.UUID);
});

test('full nuke replaces every group key and encrypts with only the new keyring', () => {
  const f = fixture();
  const next = rotated(f.store);
  const result = credentials.commitCredentialNuke(next, {
    kind: 'full',
    storePath: f.storePath,
    canonicalStorePath: f.storePath,
    keyringPath: f.keyringPath,
    secretsFilePath: f.secretsFilePath
  });
  const newKeys = secretTools.readKeyring(f.keyringPath);

  for (const group of Object.keys(f.keys)) assert.notEqual(newKeys[group], f.keys[group]);
  assert.deepEqual(result.keyringGroups.sort(), Object.keys(f.keys).sort());
  const file = secretTools.readSecretsFile(f.secretsFilePath);
  assert.equal(secretTools.decryptSecretsFile(file, newKeys).UUID, next.credentials.UUID);
  assert.throws(() => secretTools.decryptSecretsFile(file, f.keys));
});

test('full nuke refuses a custom store before changing any file', () => {
  const f = fixture();
  const before = fs.readFileSync(f.storePath);
  assert.throws(() => credentials.commitCredentialNuke(rotated(f.store), {
    kind: 'full',
    storePath: f.storePath,
    canonicalStorePath: path.join(f.dir, 'canonical.json'),
    keyringPath: f.keyringPath,
    secretsFilePath: f.secretsFilePath
  }), /custom --store/);
  assert.deepEqual(fs.readFileSync(f.storePath), before);
});

test('a failed full nuke restores store, backup, keyring and ciphertext byte-for-byte', () => {
  const f = fixture();
  const targets = [f.storePath, f.keyringPath, f.secretsFilePath];
  const before = new Map(targets.map((target) => [target, fs.readFileSync(target)]));

  assert.throws(() => credentials.commitCredentialNuke(rotated(f.store), {
    kind: 'full',
    storePath: f.storePath,
    canonicalStorePath: f.storePath,
    keyringPath: f.keyringPath,
    secretsFilePath: f.secretsFilePath,
    io: {
      writeStore: storeTools.writeStore,
      writeKeyring: secretTools.writeKeyring,
      writeSecretsFile: () => { throw new Error('simulated ciphertext failure'); }
    }
  }), /simulated ciphertext failure/);

  for (const target of targets) assert.deepEqual(fs.readFileSync(target), before.get(target));
  assert.equal(fs.existsSync(f.storePath + '.bak'), false, 'new backup is removed during rollback');
});
