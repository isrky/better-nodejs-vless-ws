'use strict';

// The credential manager.
//
// The menu takes its reader and writer as parameters, which is what makes the
// whole loop drivable from here with a scripted array — no TTY, no readline, no
// pseudo-terminal. What that seam cannot cover (real SIGINT/EOF handling, and
// how a terminal echoes a typed secret) is covered by subprocess tests below
// and, beyond that, by a manual checklist in CREDENTIALS.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

let cm;
let cs;

test.before(async () => {
  cm = await import('../tools/credentials.mjs');
  cs = await import('../tools/credstore.mjs');
});

function tmpStore() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'creds-')), 'credentials.json');
  const store = cs.emptyStore();
  Object.assign(store.credentials, {
    UUID: '00000000-0000-4000-8000-000000000001',
    WSPATH: '/test-ws-path',
    FLY_HOST: 'fly.example.dev',
    WORKER_HOST: 'worker.example.dev'
  });
  cs.writeStore(p, store);
  return { storePath: p, store };
}

/** Drive the menu with a fixed list of answers. */
async function drive(answers, { storePath, store }) {
  const said = [];
  const queue = answers.slice();
  const code = await cm.runMenu({
    storePath,
    store,
    ask: async () => {
      if (!queue.length) throw new Error('the menu asked more questions than were scripted');
      return queue.shift();
    },
    out: (s) => said.push(String(s))
  });
  return { code, said: said.join('\n'), remaining: queue.length };
}

// ---------- the menu ----------

test('q quits cleanly', async () => {
  const ctx = tmpStore();
  const { code, remaining } = await drive(['q'], ctx);
  assert.equal(code, 0);
  assert.equal(remaining, 0);
});

test('generating a value writes it through immediately', async () => {
  // Write-through, not save-on-exit: a freshly generated UUID that existed only
  // in memory would be exactly the thing you cannot recover.
  const ctx = tmpStore();
  const before = cs.readStore(ctx.storePath).credentials.UUID;

  const { said } = await drive(['1', 'g', 'q'], ctx);

  const after = cs.readStore(ctx.storePath).credentials.UUID;
  assert.notEqual(after, before);
  assert.equal(cs.validateField('UUID', after), null);
  assert.ok(!said.includes(after.slice(9)), 'only the first 8 characters may be shown');
});

test('bare enter keeps the current value', async () => {
  const ctx = tmpStore();
  const before = cs.readStore(ctx.storePath).credentials.UUID;
  await drive(['1', '', 'q'], ctx);
  assert.equal(cs.readStore(ctx.storePath).credentials.UUID, before);
});

test('an invalid value re-prompts the same field instead of aborting', async () => {
  const ctx = tmpStore();
  const { said, remaining } = await drive(['3', 'https://nope.example', 'good.example.dev', 'q'], ctx);

  assert.equal(remaining, 0, 'the session must survive a bad entry');
  assert.match(said, /not a bare lowercase hostname/);
  assert.equal(cs.readStore(ctx.storePath).credentials.FLY_HOST, 'good.example.dev');
});

test('a rejected value is never echoed back', async () => {
  const ctx = tmpStore();
  const { said } = await drive(['1', 'SENTINEL-BAD-UUID-VALUE', 'q', 'q'], ctx);
  assert.ok(!said.includes('SENTINEL-BAD-UUID-VALUE'), 'the rejected input may be a credential');
});

test('a required field refuses to be cleared, an optional one accepts it', async () => {
  const ctx = tmpStore();
  const { said } = await drive(['1', 'c', 'q', 'q'], ctx);
  assert.match(said, /UUID is required/);
  assert.ok(cs.readStore(ctx.storePath).credentials.UUID, 'and it is still set');

  const withToken = cs.withField(cs.readStore(ctx.storePath), 'ADMIN_TOKEN', 'a'.repeat(44));
  cs.writeStore(ctx.storePath, withToken);
  await drive(['6', 'c', 'q'], { storePath: ctx.storePath, store: withToken });
  assert.equal('ADMIN_TOKEN' in cs.readStore(ctx.storePath).credentials, false);
});

test('PROVISION_SECRET_PREVIOUS cannot be generated from the menu', async () => {
  const ctx = tmpStore();
  const { said } = await drive(['8', 'g', 'q', 'q'], ctx);
  assert.match(said, /cannot be generated/);
});

test('undo restores the previous store', async () => {
  const ctx = tmpStore();
  const original = cs.readStore(ctx.storePath).credentials.UUID;

  await drive(['1', 'g', 'q'], ctx);
  const changed = cs.readStore(ctx.storePath).credentials.UUID;
  assert.notEqual(changed, original);

  await drive(['u', 'q'], { storePath: ctx.storePath, store: cs.readStore(ctx.storePath) });
  assert.equal(cs.readStore(ctx.storePath).credentials.UUID, original);
});

test('an unknown menu choice is reported, not fatal', async () => {
  const ctx = tmpStore();
  const { said, code } = await drive(['zzz', 'q'], ctx);
  assert.match(said, /unknown choice/);
  assert.equal(code, 0);
});

// ---------- the CA submenu ----------

test('the CA submenu sets all three states without ever typing an empty string', async () => {
  const ctx = tmpStore();

  // 2 = none -> the explicit empty string
  await drive(['5', '2', 'q'], ctx);
  assert.equal(cs.readStore(ctx.storePath).credentials.INTERCEPT_CA_FILE, '');

  // 1 = bundled -> the key is deleted, which is a different state from ''
  await drive(['5', '1', 'q'], { storePath: ctx.storePath, store: cs.readStore(ctx.storePath) });
  assert.equal('INTERCEPT_CA_FILE' in cs.readStore(ctx.storePath).credentials, false);

  // 3 = a path
  await drive(['5', '3', 'test/fixtures/ca.pem', 'q'],
    { storePath: ctx.storePath, store: cs.readStore(ctx.storePath) });
  assert.equal(cs.readStore(ctx.storePath).credentials.INTERCEPT_CA_FILE, 'test/fixtures/ca.pem');
});

test('the CA submenu rejects a DER path and re-prompts', async () => {
  const ctx = tmpStore();
  const { said } = await drive(['5', '3', 'MEB_SERTIFIKASI.cer', 'q', 'q'], ctx);
  assert.match(said, /DER/);
});

// ---------- reports ----------

test('the menu shows every field and leaks no secret', () => {
  const store = cs.emptyStore();
  for (const f of cs.FIELDS) store.credentials[f.key] = `SENTINEL-${f.key}-VALUE`;

  const text = cm.renderMenu(store, '/tmp/x/credentials.json');
  for (const f of cs.FIELDS) {
    assert.ok(text.includes(f.key), `${f.key} must appear in the menu`);
    if (f.secret) {
      assert.ok(!text.includes(`SENTINEL-${f.key}-VALUE`), `${f.key} leaked into the menu`);
    }
  }
});

test('the confirmation prompt names keys and platforms but no values', () => {
  const store = cs.emptyStore();
  for (const f of cs.FIELDS) store.credentials[f.key] = `SENTINEL-${f.key}-VALUE`;

  const text = cm.formatRevealPrompt(cs.pushPlan(store), { fly: 'my-app', worker: 'my-worker' });

  assert.match(text, /my-app/);
  assert.match(text, /my-worker/, 'the Worker project name, not its route');
  assert.match(text, /UUID/);
  for (const f of cs.FIELDS) {
    if (f.secret) assert.ok(!text.includes(`SENTINEL-${f.key}-VALUE`), `${f.key} leaked into the prompt`);
  }
});

test('the reveal prints each secret under the right platform', () => {
  // The one place in the tool that prints a credential, and therefore the one
  // place worth asserting about in this direction.
  const store = cs.emptyStore();
  for (const f of cs.FIELDS) store.credentials[f.key] = `SENTINEL-${f.key}-VALUE`;

  const plan = cs.pushPlan(store);
  const text = cm.formatReveal(plan, store, { fly: 'my-app', worker: 'my-worker' });

  const flyPart = text.slice(text.indexOf('Fly —'), text.indexOf('Cloudflare —'));
  const cfPart = text.slice(text.indexOf('Cloudflare —'));

  assert.ok(flyPart.includes('SENTINEL-ADMIN_TOKEN-VALUE'), 'ADMIN_TOKEN belongs to Fly');
  assert.ok(!cfPart.includes('SENTINEL-ADMIN_TOKEN-VALUE'), 'and not to the Worker');
  assert.ok(cfPart.includes('SENTINEL-PROXYIP-VALUE'), 'PROXYIP belongs to the Worker');
  assert.ok(!flyPart.includes('SENTINEL-PROXYIP-VALUE'), 'and not to Fly');

  // Shared keys appear in both sections.
  assert.ok(flyPart.includes('SENTINEL-UUID-VALUE') && cfPart.includes('SENTINEL-UUID-VALUE'));

  // Render inputs are listed by name under "not pushed", and their values never
  // appear in either dashboard section as something to paste. Two legitimate
  // exceptions are stripped first: the admin URL is built from FLY_HOST, and a
  // PUBLIC_HOST drift warning quotes the value it is complaining about. Both
  // are hostnames, not secrets.
  assert.match(text, /Not pushed anywhere: .*FLY_HOST/);
  const pasteable = (s) => s.split('\n').filter((l) => !l.includes('://')).join('\n');
  for (const part of [pasteable(flyPart),
                      pasteable(cfPart.slice(0, cfPart.indexOf('Not pushed anywhere')))]) {
    assert.ok(!part.includes('SENTINEL-FLY_HOST-VALUE'), 'render inputs are not pushed');
    assert.ok(!part.includes('SENTINEL-WORKER_HOST-VALUE'));
    assert.ok(!part.includes('SENTINEL-INTERCEPT_CA_FILE-VALUE'));
  }
});

test('the reveal hands over an admin URL with the token encoded', () => {
  // The step this removes: a token pasted raw into ?token= whose "+" decodes to
  // a space, failing to match and serving the decoy — which looks like an
  // outage. Encoding here is belt-and-braces now that generation is hex, but it
  // still covers a token someone set by hand.
  const store = cs.emptyStore();
  store.credentials.FLY_HOST = 'edge.example.dev';
  store.credentials.ADMIN_TOKEN = 'needs+encoding/here=';

  assert.equal(
    cm.adminUrl(store),
    'https://edge.example.dev/admin-stats?token=needs%2Bencoding%2Fhere%3D'
  );

  const text = cm.formatReveal(cs.pushPlan(store), store, { fly: 'a', worker: 'b' });
  const flyPart = text.slice(text.indexOf('Fly —'), text.indexOf('Not pushed anywhere'));
  assert.ok(flyPart.includes(cm.adminUrl(store)), 'the URL belongs with the Fly secrets');
  assert.ok(!text.includes('?token=needs+encoding'), 'the raw token must not be linked');
});

test('there is no admin URL to hand over when it would be a lie', () => {
  const noHost = cs.emptyStore();
  noHost.credentials.ADMIN_TOKEN = 'a'.repeat(64);
  assert.equal(cm.adminUrl(noHost), null, 'no host to build one from');

  // With ADMIN_TOKEN unset the route is hidden behind the decoy, so linking it
  // would send you to a page that cannot exist.
  const noToken = cs.emptyStore();
  noToken.credentials.FLY_HOST = 'edge.example.dev';
  assert.equal(cm.adminUrl(noToken), null);

  const text = cm.formatReveal(cs.pushPlan(noToken), noToken, { fly: 'a', worker: 'b' });
  assert.ok(!text.includes('/admin-stats'), 'and it is not mentioned');
});

test('the reveal warns about the Cloudflare secret-vs-variable trap', () => {
  // A plaintext variable is silently overwritten from wrangler.toml on the next
  // deploy; a secret survives. That failure looks like the tunnel breaking for
  // no reason days later.
  const store = cs.emptyStore();
  store.credentials.UUID = '00000000-0000-4000-8000-000000000001';
  store.credentials.PROXYIP = '1.2.3.4';

  const text = cm.formatReveal(cs.pushPlan(store), store, { fly: 'a', worker: 'b' });
  assert.match(text, /SECRET, not a plaintext Variable/);
  assert.match(text, /wrangler deploy/);
});

test('the reveal is gated: n prints nothing, y prints the values', async () => {
  const ctx = tmpStore();

  const no = await drive(['p', 'n', 'q'], ctx);
  assert.ok(!no.said.includes(ctx.store.credentials.UUID), 'answering n must print no value');
  assert.match(no.said, /nothing printed/);

  const yes = await drive(['p', 'y', 'q'], ctx);
  assert.ok(yes.said.includes(ctx.store.credentials.UUID), 'answering y must print the value');
});

test('the platform names come from the committed config, and degrade when absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
  fs.writeFileSync(path.join(dir, 'fly.toml'), 'app = "some-app"\nprimary_region = "fra"\n');
  fs.writeFileSync(path.join(dir, 'wrangler.toml'), 'name = "some-worker"\nmain = "x.mjs"\n');
  assert.deepEqual(cs.platformNames(dir), { fly: 'some-app', worker: 'some-worker' });

  // The Worker project is named by `name`, never by the route it serves — which
  // is why this is read rather than guessed from a hostname.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
  const fallback = cs.platformNames(empty);
  assert.match(fallback.fly, /^<.*>$/, 'a missing file degrades, it does not throw');
  assert.match(fallback.worker, /^<.*>$/);
});

test('the import description reports fingerprints, never values', () => {
  const store = cs.emptyStore();
  store.credentials.UUID = 'aaaa';
  // SOME_OLD_KEY is deliberately not in FIELDS: an unmanaged key must still be
  // imported and reported, because dropping one is the same failure as losing
  // it — PROXYIP lived in .env for exactly that reason.
  const text = cm.describeImport(cs.planImport(store, { UUID: 'bbbb', SOME_OLD_KEY: '1.2.3.4' }));

  assert.match(text, /differs:\s+UUID/);
  assert.ok(!text.includes('bbbb'), 'the incoming value must not appear');
  assert.match(text, /unmanaged:\s+SOME_OLD_KEY/);
  assert.match(text, /new:\s+SOME_OLD_KEY/, 'and it is still imported');
});

// ---------- process-level contracts ----------

function run(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT, input: '', timeout: 15_000, encoding: 'utf8', ...opts
  });
}

test('--status never blocks on stdin', () => {
  const { storePath } = tmpStore();
  const r = run(['tools/credentials.mjs', '--status', '--store', storePath]);
  assert.notEqual(r.signal, 'SIGTERM', 'it hung waiting for input');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /credentials/);
});

test('with no TTY and no flags it reports instead of prompting', () => {
  const { storePath } = tmpStore();
  const r = run(['tools/credentials.mjs', '--store', storePath]);
  assert.notEqual(r.signal, 'SIGTERM', 'it hung waiting for input');
  assert.match(r.stderr, /not a terminal/);
});

test('render-configs never blocks on stdin', () => {
  // npm run configs and configs:check are called from scripts; a prompt on that
  // path would hang whatever called them.
  const r = run(['tools/render-configs.mjs', '--check']);
  assert.notEqual(r.signal, 'SIGTERM', 'it hung waiting for input');
  assert.ok([0, 1, 2].includes(r.status), `unexpected exit ${r.status}`);
});

test('--push refuses without a terminal, and writes no value to the pipe', () => {
  // The guard that stops `npm run creds:push > notes.txt` from putting live
  // credentials in a file. There is no way to confirm without a TTY, so the only
  // safe answer is no.
  const { storePath, store } = tmpStore();
  const r = run(['tools/credentials.mjs', '--push', '--store', storePath]);

  assert.notEqual(r.signal, 'SIGTERM', 'it hung waiting for a confirmation it cannot get');
  assert.equal(r.status, 1);
  assert.ok(!r.stdout.includes(store.credentials.UUID), 'a secret reached the pipe');
  assert.ok(!r.stdout.includes(store.credentials.WSPATH));
  assert.match(r.stdout, /UUID/, 'the names are still safe to show');
  assert.match(r.stderr, /refusing/);
});

test('--push --yes prints the values with no prompt', () => {
  const { storePath, store } = tmpStore();
  const r = run(['tools/credentials.mjs', '--push', '--yes', '--store', storePath]);

  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes(store.credentials.UUID), 'the deliberate case still works');
  assert.ok(!/Continue\?/.test(r.stdout), '--yes must not prompt');
});

test('the retired pipe flags are gone rather than silently ignored', () => {
  // --get and `--push fly` used to write values to stdout. If either came back
  // as a no-op that fell through to the status report, a muscle-memory
  // invocation would look like it worked and push nothing.
  const { storePath, store } = tmpStore();

  const get = run(['tools/credentials.mjs', '--get', 'UUID', '--store', storePath]);
  assert.ok(!get.stdout.includes(store.credentials.UUID), '--get must not print a value');

  const fly = run(['tools/credentials.mjs', '--push', 'fly', '--store', storePath]);
  assert.ok(!fly.stdout.includes(`UUID=${store.credentials.UUID}`), 'no KEY=value dump');
  assert.ok(!fly.stdout.includes(store.credentials.UUID), 'and no bare value either');
});

test('--help exits 0 and mentions the render step', () => {
  const r = run(['tools/credentials.mjs', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /npm run configs/);
});
