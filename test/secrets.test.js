'use strict';

// No credential may reach a committable file.
//
// This exists because it already happened once: a test fixture was written with
// the operator's live UUID and WSPATH copied verbatim out of their local
// credentials, and the leak guard of the day only scanned templates/ — not the
// test file doing the leaking.
//
// Two layers, deliberately:
//
//   * a SHAPE guard, which works on a fresh clone with no credentials present
//     and catches anything that merely looks like a credential;
//   * a REAL-VALUE guard, which is the actual property but can only run on a
//     machine that has the credentials to compare against.
//
// Only SECRET-valued fields are checked. Hostnames live in the same store but
// are public by construction — `edge.isrky.dev` is committed in fly.toml and
// `assets.isrky.dev` in wrangler.toml — so flagging them would be noise that
// trains people to ignore this test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Keys whose value must never appear in a tracked file. Mirrors the `secret`
// column of the credential schema; move to FIELDS once credstore.mjs exists.
const SECRET_KEYS = ['UUID', 'WSPATH', 'ADMIN_TOKEN', 'PROVISION_SECRET', 'PROVISION_SECRET_PREVIOUS'];

const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * UUID-shaped literals that are allowed to appear in the repo.
 *
 * Every entry is either structurally fake or already public. Adding a value
 * here is the review moment — if a new fixture needs one, someone has to look
 * at this list and say why.
 */
const ALLOWED_UUIDS = new Set([
  '7bd180e8-1142-4387-93f5-03e8d750a896',   // the insecure default, published in this repo
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-4000-8000-000000000000',
  '00000000-0000-4000-8000-000000000001',   // templates.test.js FIXTURE
  '00000000-0000-4000-8000-000000000002',   // credstore.test.js backup round trip
  '00000000-0000-4000-8000-0000000000ab',   // credstore.test.js redaction check
  '00000000-0000-4000-8000-00000000000A',   // credstore.test.js uppercase rejection
  '00010203-0405-0607-0809-0a0b0c0d0e0f',   // formatUuid byte-order check
  '00112233-4455-6677-8899-aabbccddeeff',   // config.test.js bare-hex check
  // Derived from the fixed test secret in users.test.js — reproducible from a
  // committed constant, so they reveal nothing.
  'bb3d6381-f832-4549-b607-541f00917947',
  'af71b88d-eb92-4720-9740-50232f7313c4',
  '8e30a51e-e631-4c6d-9219-f4031fecb029',
  'dddc407c-c579-41a7-869c-3f6b4e314532'
]);

/**
 * Every file a `git add -A` would stage: tracked, plus untracked that is not
 * gitignored.
 *
 * Tracked-only would miss the case this whole file exists for — the fixture
 * leak was in a brand-new, still-untracked test file. A guard that only fires
 * after the credential is already committed is not a guard.
 */
function committableFiles() {
  return execFileSync(
    'git', ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, encoding: 'utf8' }
  )
    .split('\n')
    .filter(Boolean);
}

function readIfText(file) {
  const full = path.join(ROOT, file);
  try {
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return null;   // binary
    return buf.toString('utf8');
  } catch {
    return null;   // deleted or unreadable
  }
}

/** Read the credential store, whichever form it currently takes. */
function loadLocalSecrets() {
  const jsonPath = path.join(ROOT, 'local/credentials.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const store = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      return store.credentials || {};
    } catch {
      return null;
    }
  }

  const envPath = path.join(ROOT, 'local/.env');
  if (!fs.existsSync(envPath)) return null;

  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

test('no committable file contains a UUID-shaped literal that is not allowlisted', () => {
  for (const file of committableFiles()) {
    const text = readIfText(file);
    if (text === null) continue;

    for (const found of text.match(UUID_SHAPE) || []) {
      assert.ok(ALLOWED_UUIDS.has(found),
        `${file} contains an unrecognised UUID-shaped literal. If it is a fixture, ` +
        'add it to ALLOWED_UUIDS in test/secrets.test.js; if it is real, remove it.');
    }
  }
});

test('no committable file contains a ws-path-shaped literal', () => {
  // A WSPATH is /<32 hex>. Anything matching that in a tracked file is either a
  // real path or a fixture that should not look like one.
  const shape = /"\/[0-9a-f]{32}(\?[^"]*)?"/g;

  for (const file of committableFiles()) {
    const text = readIfText(file);
    if (text === null) continue;
    const hits = text.match(shape) || [];
    assert.deepEqual(hits, [], `${file} contains a ws-path-shaped literal: ${hits.join(', ')}`);
  }
});

test('no committable file contains a live secret from the local store', {
  skip: loadLocalSecrets() === null && 'no local credential store on this machine'
}, () => {
  // The real property. The shape guards above are proxies for it; this is the
  // one that would have caught the fixture leak the moment it was written.
  const secrets = loadLocalSecrets();
  const files = committableFiles();

  for (const key of SECRET_KEYS) {
    const value = secrets[key];
    // Short values would false-positive against ordinary text.
    if (typeof value !== 'string' || value.length < 12) continue;

    for (const file of files) {
      const text = readIfText(file);
      if (text === null) continue;
      // Name the key and the file. Never the value.
      assert.ok(!text.includes(value), `${file} contains the live value of ${key}`);
    }
  }
});

test('the guard actually looks at a meaningful number of files', () => {
  // Guards against the whole suite silently passing because git ls-files
  // returned nothing (wrong cwd, not a repo, etc).
  const files = committableFiles();
  assert.ok(files.length > 20, `only ${files.length} committable files found`);
  assert.ok(files.includes('package.json'));
});
