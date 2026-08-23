'use strict';

// The credential store.
//
// Two tests here carry more weight than the rest:
//
//   * the CA tri-state round trip — a store that collapses "key absent" into
//     "empty string" silently strips the pinned CA from all four configs, and
//     that only surfaces on the intercepting network where it is required, as
//     an x509 error that reads like a network fault;
//   * the sentinel leak test — table-driven over FIELDS, so a field added later
//     is covered without anyone remembering to cover it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let cs;
let renderer;
let INTERCEPT_CA_PEM;

test.before(async () => {
  cs = await import('../tools/credstore.mjs');
  renderer = await import('../tools/render-configs.mjs');
  ({ INTERCEPT_CA_PEM } = require('../src/node/interceptca.js'));
});

function tmpStorePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'credstore-')), 'credentials.json');
}

function fullStore() {
  const s = cs.emptyStore();
  Object.assign(s.credentials, {
    UUID: '00000000-0000-4000-8000-000000000001',
    WSPATH: '/test-ws-path',
    FLY_HOST: 'fly.example.dev',
    WORKER_HOST: 'worker.example.dev'
  });
  return s;
}

// ---------- schema ----------

test('every field has the properties the tool relies on', () => {
  for (const f of cs.FIELDS) {
    assert.match(f.key, /^[A-Z][A-Z0-9_]*$/, `${f.key} must be SCREAMING_CASE`);
    assert.equal(typeof f.secret, 'boolean', f.key);
    assert.equal(typeof f.required, 'boolean', f.key);
    assert.ok(Array.isArray(f.pushTo), f.key);
    assert.ok(typeof f.help === 'string' && f.help.length > 0, f.key);
  }
  assert.equal(new Set(cs.FIELDS.map((f) => f.key)).size, cs.FIELDS.length, 'duplicate key');
});

test('generated values pass their own validation', () => {
  for (const f of cs.FIELDS) {
    if (!f.generate) continue;
    for (let i = 0; i < 5; i++) {
      const value = cs.generate(f.key);
      assert.equal(cs.validateField(f.key, value), null, `${f.key}: ${value}`);
    }
  }
});

test('every generated value survives a URL unchanged', () => {
  // ADMIN_TOKEN goes into /admin-stats?token=, where base64's "+" decodes to a
  // space; the token then fails to match and the request is served the decoy —
  // a 200 identical to GET /, which reads as an outage rather than a bad token.
  // Table-driven so a new generator cannot quietly reintroduce that.
  for (const f of cs.FIELDS) {
    if (!f.generate) continue;
    const value = cs.generate(f.key);
    // WSPATH is a path, so its leading slash is legitimate; nothing else is.
    const encoded = encodeURIComponent(value).replace(/%2F/g, '/');
    assert.equal(encoded, value, `${f.key} generates a value that a URL would mangle`);
  }
});

test('a generated ADMIN_TOKEN is 32 bytes of lowercase hex', () => {
  const token = cs.generate('ADMIN_TOKEN');
  assert.match(token, /^[0-9a-f]{64}$/, 'same 256 bits as before, URL-safe alphabet');
});

test('PROVISION_SECRET_PREVIOUS is never generatable', () => {
  // It only ever holds a value that was previously current; generating one
  // would authenticate a credential nobody was ever issued.
  assert.throws(() => cs.generate('PROVISION_SECRET_PREVIOUS'), /cannot be generated/);
});

test('validateField catches the failures that would otherwise be silent', () => {
  assert.equal(cs.validateField('UUID', '00000000-0000-4000-8000-000000000001'), null);
  assert.match(cs.validateField('UUID', 'nope'), /8-4-4-4-12/);
  assert.match(cs.validateField('UUID', '7bd180e8-1142-4387-93f5-03e8d750a896'), /published/);
  assert.match(cs.validateField('UUID', '00000000-0000-4000-8000-00000000000A'), /lowercase/);

  assert.equal(cs.validateField('FLY_HOST', 'edge.example.dev'), null);
  // A pasted dashboard URL and stray case are normalised away, so they validate.
  for (const ok of ['https://edge.example.dev', 'https://edge.example.dev/', 'EDGE.example.dev']) {
    assert.equal(cs.validateField('FLY_HOST', ok), null, `${ok} must be accepted`);
  }
  // A port is not stripped — dropping it would silently change the target.
  for (const bad of ['edge.example.dev:443', 'https://edge.example.dev:443', 'edge']) {
    assert.ok(cs.validateField('FLY_HOST', bad), `${bad} must be rejected`);
  }

  assert.equal(cs.validateField('WSPATH', '/abc'), null);
  assert.ok(cs.validateField('WSPATH', 'abc'), 'must start with /');
  assert.ok(cs.validateField('WSPATH', '/a b'));
  assert.ok(cs.validateField('WSPATH', '/a#b'), '# truncates the path');

  assert.ok(cs.validateField('INTERCEPT_CA_FILE', 'MEB_SERTIFIKASI.cer'), 'DER must be rejected');
  assert.ok(cs.validateField('INTERCEPT_CA_FILE', 'nope.pem'), 'missing file must be rejected');
  assert.equal(cs.validateField('INTERCEPT_CA_FILE', ''), null, 'empty means "no pinned CA"');

  assert.equal(cs.validateField('USERS', 'alice,bob'), null);
  assert.match(cs.validateField('USERS', 'alice,<script>'), /invalid labels/);

  // ADMIN_TOKEN rejects only what a URL mangles, not "must be hex" — a token
  // set by hand from a password manager stays legal.
  assert.equal(cs.validateField('ADMIN_TOKEN', 'a'.repeat(64)), null);
  assert.equal(cs.validateField('ADMIN_TOKEN', 'Sane-Token_1.2~3'), null);
  for (const bad of ['tok+en', 'tok/en', 'token=', 'tok&en', 'tok?en', 'tok#en']) {
    assert.match(cs.validateField('ADMIN_TOKEN', bad), /URL-safe/, `${bad} must be rejected`);
  }
  assert.match(cs.validateField('ADMIN_TOKEN', 'tok en'), /whitespace/, 'whitespace keeps its own reason');
  assert.match(cs.validateField('ADMIN_TOKEN', ''), /is empty/);

  assert.equal(cs.validateField('NOT_A_FIELD', 'anything'), null, 'unmanaged keys are carried, not judged');
});

test('validateStore reports every problem at once', () => {
  const problems = cs.validateStore(cs.emptyStore()).map((p) => p.key);
  assert.deepEqual(problems.sort(), ['FLY_HOST', 'UUID', 'WORKER_HOST', 'WSPATH']);
});

test('identical hosts are rejected — the udp configs would target the Worker', () => {
  const s = fullStore();
  s.credentials.WORKER_HOST = s.credentials.FLY_HOST;
  assert.match(cs.validateStore(s).find((p) => p.key === 'WORKER_HOST').reason, /identical to FLY_HOST/);
});

test('a previous provisioning secret equal to the current one is rejected', () => {
  const s = fullStore();
  s.credentials.PROVISION_SECRET = 'aaa';
  s.credentials.PROVISION_SECRET_PREVIOUS = 'aaa';
  assert.ok(cs.validateStore(s).some((p) => p.key === 'PROVISION_SECRET_PREVIOUS'));
});

test('requireRenderInputs ignores server-side problems', () => {
  const s = fullStore();
  s.credentials.ADMIN_TOKEN = '';          // invalid, but not a render input
  assert.doesNotThrow(() => cs.requireRenderInputs(s));

  delete s.credentials.UUID;
  assert.throws(() => cs.requireRenderInputs(s), /UUID.*missing/s);
});

// ---------- the CA tri-state ----------

test('the CA tri-state survives a write/read/render round trip', () => {
  const p = tmpStorePath();

  const cases = [
    ['key absent -> bundled', (c) => { delete c.INTERCEPT_CA_FILE; },
      (lines) => assert.deepEqual(lines, INTERCEPT_CA_PEM)],
    ['empty string -> none', (c) => { c.INTERCEPT_CA_FILE = ''; },
      (lines) => assert.deepEqual(lines, [])],
    ['path -> that file', (c) => { c.INTERCEPT_CA_FILE = 'test/fixtures/ca.pem'; },
      (lines) => assert.equal(lines[0], '-----BEGIN CERTIFICATE-----')]
  ];

  for (const [label, mutate, expect] of cases) {
    const s = fullStore();
    mutate(s.credentials);
    cs.writeStore(p, s);
    expect(renderer.loadCaLines(cs.toRenderEnv(cs.readStore(p))), label);
  }
});

test('toRenderEnv preserves absence and refuses null', () => {
  const s = fullStore();
  assert.equal('INTERCEPT_CA_FILE' in cs.toRenderEnv(s), false, 'absence must survive');

  s.credentials.INTERCEPT_CA_FILE = '';
  assert.equal(cs.toRenderEnv(s).INTERCEPT_CA_FILE, '', 'empty must survive as empty');

  s.credentials.INTERCEPT_CA_FILE = null;
  assert.throws(() => cs.toRenderEnv(s), /null/, 'null is ambiguous and must not be coerced');
});

test('withField deletes on null rather than writing an empty string', () => {
  // The two are different states for INTERCEPT_CA_FILE, so they need different
  // code paths — "clear" must never accidentally mean "no pinned CA".
  const s = cs.withField(fullStore(), 'INTERCEPT_CA_FILE', '');
  assert.equal(s.credentials.INTERCEPT_CA_FILE, '');

  const cleared = cs.withField(s, 'INTERCEPT_CA_FILE', null);
  assert.equal('INTERCEPT_CA_FILE' in cleared.credentials, false);
});

test('withField stores a host stripped of scheme, path and case', () => {
  const s = cs.withField(fullStore(), 'DENO_HOST', 'https://App.Example.Deno.NET/');
  assert.equal(s.credentials.DENO_HOST, 'app.example.deno.net');
});

// ---------- I/O ----------

test('a store round-trips and is written 0600', () => {
  const p = tmpStorePath();
  const s = fullStore();
  cs.writeStore(p, s);

  assert.deepEqual(cs.readStore(p), s);
  assert.equal(cs.storeMode(p), '600');
});

test('a version that cannot be identified is a hard failure, never an empty store', () => {
  const p = tmpStorePath();

  for (const [label, body] of [
    ['missing version', '{"credentials":{}}'],
    ['non-integer version', '{"version":"1","credentials":{}}'],
    ['future version', `{"version":${cs.CURRENT_VERSION + 1},"credentials":{}}`],
    ['no credentials object', '{"version":1}'],
    ['not JSON', 'nonsense']
  ]) {
    fs.writeFileSync(p, body);
    assert.throws(() => cs.readStore(p), cs.StoreError, label);
  }
});

test('writing keeps one backup generation, and restore brings it back', () => {
  const p = tmpStorePath();
  const first = fullStore();
  cs.writeStore(p, first);

  const second = cs.withField(first, 'UUID', '00000000-0000-4000-8000-000000000002');
  cs.writeStore(p, second);
  assert.equal(cs.readStore(p).credentials.UUID, '00000000-0000-4000-8000-000000000002');

  assert.equal(cs.restoreBackup(p).credentials.UUID, first.credentials.UUID);
});

test('a missing store names the fix rather than throwing ENOENT', () => {
  assert.throws(() => cs.readStore('/nonexistent/credentials.json'), /npm run creds/);
});

// ---------- legacy import ----------

test('planImport classifies by key and fingerprint, never by value', () => {
  const store = fullStore();
  const incoming = {
    UUID: store.credentials.UUID,                        // same
    WSPATH: '/different',                                // differs
    ADMIN_TOKEN: 'brand-new',                            // add
    SOMETHING_ELSE: 'unmanaged'                          // add + unknown
  };

  const plan = cs.planImport(store, incoming);
  assert.deepEqual(plan.same, ['UUID']);
  assert.deepEqual(plan.add.sort(), ['ADMIN_TOKEN', 'SOMETHING_ELSE']);
  assert.deepEqual(plan.unknown, ['SOMETHING_ELSE']);

  const differ = plan.differ.find((d) => d.key === 'WSPATH');
  assert.match(differ.current, /^[0-9a-f]{8}$/);
  assert.match(differ.incoming, /^[0-9a-f]{8}$/);
  assert.ok(!JSON.stringify(plan).includes('/different'), 'no value may appear in the plan');
});

test('an unmanaged key is reported but still importable', () => {
  // Dropping a key the tool does not manage is the same failure as losing it —
  // PROXYIP lived in .env for exactly this reason.
  const plan = cs.planImport(cs.emptyStore(), { PROXYIP: '1.2.3.4' });
  assert.deepEqual(plan.add, ['PROXYIP']);
});

test('parseLegacyEnv stays strict about anything shell would read differently', () => {
  const env = cs.parseLegacyEnv("# c\n\nUUID=plain\nexport WSPATH=/x\nA='q'\nB=\"d\"");
  assert.equal(env.UUID, 'plain');
  assert.equal(env.WSPATH, '/x');
  assert.equal(env.A, 'q');
  assert.equal(env.B, 'd');

  for (const [why, text] of Object.entries({
    'duplicate key': 'UUID=a\nUUID=b',
    'spaces around =': 'UUID = a',
    'unquoted metacharacter': 'UUID=a;b',
    'unquoted space': 'UUID=a b',
    'unterminated quote': 'UUID="a',
    'not an assignment': 'just words'
  })) {
    assert.throws(() => cs.parseLegacyEnv(text), cs.StoreError, why);
  }
});

test('parseLegacyEnv never echoes a value in its error', () => {
  try {
    cs.parseLegacyEnv('UUID=super-secret-value;rm');
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(!e.message.includes('super-secret-value'));
    assert.ok(e.message.includes('UUID'), 'but it must name the key');
  }
});

// ---------- push plan ----------

test('the push plan routes each key to the right place and carries no values', () => {
  const s = fullStore();
  Object.assign(s.credentials, {
    ADMIN_TOKEN: 'a'.repeat(44),
    PROVISION_SECRET: 'b'.repeat(44),
    USERS: 'alice bob',
    PROXYIP: '203.0.113.5:8443'
  });

  const plan = cs.pushPlan(s);
  assert.deepEqual(plan.fly.sort(), ['ADMIN_TOKEN', 'PROVISION_SECRET', 'USERS', 'UUID', 'WSPATH']);
  assert.deepEqual(plan.wrangler.sort(), ['PROXYIP', 'UUID', 'WSPATH']);
  assert.deepEqual(plan.deno.sort(), ['PROXYIP', 'UUID', 'WSPATH']);
  assert.deepEqual(plan.renderOnly.sort(), ['FLY_HOST', 'WORKER_HOST']);

  // No SECRET value may appear. Hostnames legitimately do — the PUBLIC_HOST
  // drift warning has to name both to be worth reading.
  const serialised = JSON.stringify(plan);
  for (const f of cs.FIELDS) {
    if (!f.secret) continue;
    const value = s.credentials[f.key];
    if (value) assert.ok(!serialised.includes(value), `the plan leaked ${f.key}`);
  }
});

test('unset keys are not pushed', () => {
  assert.deepEqual(cs.pushPlan(fullStore()).fly.sort(), ['UUID', 'WSPATH']);
});

test('serializeEnv emits KEY=value for set keys and skips unset ones', () => {
  const s = cs.emptyStore();
  s.credentials.UUID = '00000000-0000-4000-8000-000000000001';
  s.credentials.WSPATH = '/w';
  // PROXYIP deliberately left unset
  assert.equal(
    cs.serializeEnv(s, ['UUID', 'WSPATH', 'PROXYIP']),
    'UUID=00000000-0000-4000-8000-000000000001\nWSPATH=/w\n'
  );
  assert.equal(cs.serializeEnv(s, ['PROXYIP']), '', 'no set keys yields empty output');
});

test('serializeEnv single-quotes a value containing whitespace', () => {
  const s = cs.emptyStore();
  s.credentials.USERS = 'alice bob';
  assert.equal(cs.serializeEnv(s, ['USERS']), "USERS='alice bob'\n");
});

// ---------- redaction ----------

test('no surface built from the store ever contains a secret value', () => {
  // Table-driven so a field added later is covered without anyone remembering.
  const s = cs.emptyStore();
  for (const f of cs.FIELDS) s.credentials[f.key] = `SENTINEL-${f.key}-VALUE`;

  const surfaces = [
    ...cs.FIELDS.map((f) => cs.redact(f.key, s.credentials[f.key])),
    ...cs.validateStore(s).map((p) => `${p.key} ${p.reason}`),
    JSON.stringify(cs.pushPlan(s)),
    JSON.stringify(cs.planImport(s, { ...s.credentials, UUID: 'other' }))
  ];

  for (const f of cs.FIELDS) {
    if (!f.secret) continue;
    for (const surface of surfaces) {
      assert.ok(!surface.includes(`SENTINEL-${f.key}-VALUE`),
        `${f.key} leaked into: ${surface.slice(0, 90)}`);
    }
  }
});

test('redaction shows enough to compare without revealing', () => {
  assert.equal(cs.redact('UUID', '00000000-0000-4000-8000-0000000000ab'), '00000000-…');
  assert.equal(cs.redact('WSPATH', '/' + 'a'.repeat(32)), '/… (33 chars)');
  assert.match(cs.redact('ADMIN_TOKEN', 'x'.repeat(44)), /^set \(44 chars #[0-9a-f]{8}\)$/);
  assert.equal(cs.redact('FLY_HOST', 'edge.example.dev'), 'edge.example.dev');
  assert.equal(cs.redact('UUID', undefined), 'unset');
  assert.equal(cs.redact('INTERCEPT_CA_FILE', ''), 'none');
});

test('two identical secrets fingerprint alike and two different ones do not', () => {
  const a = cs.redact('ADMIN_TOKEN', 'same-value-here');
  assert.equal(a, cs.redact('ADMIN_TOKEN', 'same-value-here'));
  assert.notEqual(a, cs.redact('ADMIN_TOKEN', 'other-value-xx'));
});

// ---------- fly.toml drift ----------

test('a PUBLIC_HOST that disagrees with FLY_HOST is reported', () => {
  const s = fullStore();
  assert.ok(cs.publicHostWarnings(s).length > 0, 'fly.toml says edge.isrky.dev, store says fly.example.dev');

  s.credentials.FLY_HOST = 'edge.isrky.dev';
  assert.deepEqual(cs.publicHostWarnings(s), [], 'and none when they agree');
});
