'use strict';

// The encrypted-secrets CLI: --init-keys / --encrypt / --decrypt / --keys.
// Driven as subprocesses so the real arg parsing and TTY gating are exercised.
// Every run is pointed at a scratch store, keyring, and secrets file so the
// repo's committed src/node/secrets.enc.json is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let cs;

test.before(async () => { cs = await import('../tools/credstore.mjs'); });

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-cli-'));
  const storePath = path.join(dir, 'credentials.json');
  const store = cs.emptyStore();
  Object.assign(store.credentials, {
    UUID: '00000000-0000-4000-8000-000000000001',
    WSPATH: '/test-ws-path',
    ADMIN_TOKEN: 'a'.repeat(64),
    PROVISION_SECRET: 'b'.repeat(64),
    PROXYIP: '1.2.3.4'
  });
  cs.writeStore(storePath, store);
  return {
    dir, storePath, store,
    keyring: path.join(dir, 'secrets.keys.json'),
    encfile: path.join(dir, 'secrets.enc.json')
  };
}

function run(args, opts = {}) {
  return spawnSync(process.execPath, ['tools/credentials.mjs', ...args], {
    cwd: ROOT, input: '', timeout: 15_000, encoding: 'utf8', ...opts
  });
}

const paths = (s) => ['--store', s.storePath, '--keyring', s.keyring, '--secrets-file', s.encfile];

test('--init-keys writes a 0600 keyring and encrypts the store', () => {
  const s = scratch();
  const r = run(['--init-keys', ...paths(s)]);
  assert.equal(r.status, 0, r.stderr);

  assert.ok(fs.existsSync(s.keyring), 'keyring written');
  assert.equal((fs.statSync(s.keyring).mode & 0o777).toString(8), '600');
  assert.ok(fs.existsSync(s.encfile), 'secrets file written');

  const file = JSON.parse(fs.readFileSync(s.encfile, 'utf8'));
  assert.deepEqual(Object.keys(file.groups).sort(), ['common', 'edge', 'server']);
  // no plaintext secret in the committed file
  assert.ok(!fs.readFileSync(s.encfile, 'utf8').includes(s.store.credentials.UUID));
});

test('--init-keys refuses to clobber an existing keyring without --force', () => {
  const s = scratch();
  assert.equal(run(['--init-keys', ...paths(s)]).status, 0);
  const first = fs.readFileSync(s.keyring, 'utf8');

  const again = run(['--init-keys', ...paths(s)]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  assert.equal(fs.readFileSync(s.keyring, 'utf8'), first, 'keyring untouched');

  assert.equal(run(['--init-keys', '--force', ...paths(s)]).status, 0);
  assert.notEqual(fs.readFileSync(s.keyring, 'utf8'), first, '--force replaces it');
});

test('--encrypt then --decrypt round-trips the store through the file', () => {
  const s = scratch();
  assert.equal(run(['--init-keys', ...paths(s)]).status, 0);

  // wipe the store's secrets, then rebuild them from the committed file
  const stripped = cs.emptyStore();
  stripped.credentials.FLY_HOST = 'fly.example.dev';   // a render field survives
  cs.writeStore(s.storePath, stripped);

  const dec = run(['--decrypt', ...paths(s)]);
  assert.equal(dec.status, 0, dec.stderr);

  const rebuilt = cs.readStore(s.storePath).credentials;
  assert.equal(rebuilt.UUID, s.store.credentials.UUID, 'UUID recovered');
  assert.equal(rebuilt.ADMIN_TOKEN, s.store.credentials.ADMIN_TOKEN);
  assert.equal(rebuilt.PROXYIP, s.store.credentials.PROXYIP);
  assert.equal(rebuilt.FLY_HOST, 'fly.example.dev', 'render field preserved');
});

test('--decrypt without a keyring fails rather than guessing', () => {
  const s = scratch();
  const r = run(['--decrypt', ...paths(s)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no keyring/);
});

test('--keys refuses without a terminal, and prints nothing', () => {
  const s = scratch();
  assert.equal(run(['--init-keys', ...paths(s)]).status, 0);
  const keys = JSON.parse(fs.readFileSync(s.keyring, 'utf8')).keys;

  const r = run(['--keys', ...paths(s)]);
  assert.equal(r.status, 1, 'refuses off a TTY');
  assert.match(r.stderr, /refusing/);
  assert.ok(!r.stdout.includes(keys.common), 'no key reached the pipe');
});

test('--keys --yes prints each platform its two group keys', () => {
  const s = scratch();
  assert.equal(run(['--init-keys', ...paths(s)]).status, 0);
  const keys = JSON.parse(fs.readFileSync(s.keyring, 'utf8')).keys;

  const r = run(['--keys', '--yes', ...paths(s)]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /SECRETS_KEY_COMMON=/);
  assert.match(r.stdout, /SECRETS_KEY_SERVER=/);
  assert.match(r.stdout, /SECRETS_KEY_EDGE=/);
  assert.ok(r.stdout.includes(keys.common), 'the deliberate reveal shows the key');
  assert.match(r.stdout, /Fly[\s\S]*SECRETS_KEY_COMMON=.*\nSECRETS_KEY_SERVER=/,
    'Fly receives one contiguous two-line block');
  assert.match(r.stdout, /Cloudflare Worker[\s\S]*SECRETS_KEY_COMMON=.*\nSECRETS_KEY_EDGE=/,
    'Worker receives one contiguous two-line block');
});

test('--keys fly --yes narrows to just that platform', () => {
  const s = scratch();
  assert.equal(run(['--init-keys', ...paths(s)]).status, 0);
  const r = run(['--keys', 'fly', '--yes', ...paths(s)]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /SECRETS_KEY_SERVER=/, 'fly gets the server key');
  assert.ok(!/SECRETS_KEY_EDGE=/.test(r.stdout), 'and not the edge key');
});

test('--encrypt without a keyring points the user at --init-keys', () => {
  const s = scratch();
  const r = run(['--encrypt', ...paths(s)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--init-keys/);
});

test('--keys refuses to print an incomplete keyring', () => {
  const s = scratch();
  assert.equal(run(['--init-keys', ...paths(s)]).status, 0);
  const parsed = JSON.parse(fs.readFileSync(s.keyring, 'utf8'));
  delete parsed.keys.edge;
  fs.writeFileSync(s.keyring, JSON.stringify(parsed));

  const r = run(['--keys', '--yes', ...paths(s)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing edge/);
  assert.ok(!/SECRETS_KEY_COMMON=/.test(r.stdout), 'no partial set is printed');
});

test('--deno-env and --docker-env export only each platform\'s group keys', () => {
  const s = scratch();
  assert.equal(run(['--init-keys', ...paths(s)]).status, 0);
  const keys = JSON.parse(fs.readFileSync(s.keyring, 'utf8')).keys;

  const deno = run(['--deno-env', ...paths(s)]);
  assert.equal(deno.status, 0, deno.stderr);
  assert.equal(fs.readFileSync(path.join(s.dir, 'deno.env'), 'utf8'),
    `SECRETS_KEY_COMMON=${keys.common}\nSECRETS_KEY_EDGE=${keys.edge}\n`);

  const docker = run(['--docker-env', ...paths(s)]);
  assert.equal(docker.status, 0, docker.stderr);
  assert.equal(fs.readFileSync(path.join(s.dir, 'docker.env'), 'utf8'),
    `SECRETS_KEY_COMMON=${keys.common}\nSECRETS_KEY_SERVER=${keys.server}\n`);
});

test('--deno-env fails without its required keyring and writes nothing', () => {
  const s = scratch();
  const r = run(['--deno-env', ...paths(s)]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /--init-keys/);
  assert.equal(fs.existsSync(path.join(s.dir, 'deno.env')), false);
});
