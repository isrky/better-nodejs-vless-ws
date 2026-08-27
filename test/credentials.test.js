'use strict';

// The credential manager's non-interactive surface: the pure report/export
// helpers both the CLI flags and the Ink dashboard share, and the
// process-level contracts (no prompt without a TTY, no secret to a pipe).
// The interactive flows themselves live in the reducer and are tested in
// test/tui-reducer.test.js; what neither suite can cover (real keystrokes,
// terminal restore) stays with the manual checklist in CREDENTIALS.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

let cm;
let cs;
let ce;

test.before(async () => {
  cm = await import('../tools/credentials.mjs');
  cs = await import('../tools/credstore.mjs');
  ce = await import('../tools/credsecrets.mjs');
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

test('the key reveal prints paste-ready two-line blocks for every platform', () => {
  const keys = ce.generateKeys();
  const text = cm.formatKeysReveal(keys);
  const section = (from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to) : undefined);
  const fly = section('Fly', 'VPS / Docker');
  const docker = section('VPS / Docker', 'Cloudflare Worker');
  const worker = section('Cloudflare Worker', 'Deno Deploy');
  const deno = section('Deno Deploy');

  assert.ok(fly.includes(`SECRETS_KEY_COMMON=${keys.common}\nSECRETS_KEY_SERVER=${keys.server}`));
  assert.ok(docker.includes(`SECRETS_KEY_COMMON=${keys.common}\nSECRETS_KEY_SERVER=${keys.server}`));
  assert.ok(worker.includes(`SECRETS_KEY_COMMON=${keys.common}\nSECRETS_KEY_EDGE=${keys.edge}`));
  assert.ok(deno.includes(`SECRETS_KEY_COMMON=${keys.common}\nSECRETS_KEY_EDGE=${keys.edge}`));
  assert.ok(!/^\s+SECRETS_KEY_/m.test(text), 'assignment lines have no indentation and can be pasted as dotenv');
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
  // revealWithConfirmation is the CLI --push path; the dashboard's equivalent
  // gate (confirm, then print after teardown) is asserted in the reducer suite.
  const ctx = tmpStore();
  const gate = async (answer) => {
    const said = [];
    const shown = await cm.revealWithConfirmation(ctx.store, async () => answer, (s) => said.push(String(s)));
    return { shown, said: said.join('\n') };
  };

  const no = await gate('n');
  assert.equal(no.shown, false);
  assert.ok(!no.said.includes(ctx.store.credentials.UUID), 'answering n must print no value');
  assert.match(no.said, /nothing printed/);

  const yes = await gate('y');
  assert.equal(yes.shown, true);
  assert.ok(yes.said.includes(ctx.store.credentials.UUID), 'answering y must print the value');
});

test('exportDenoEnv writes only Deno\'s two group keys at 0600', () => {
  const ctx = tmpStore();
  const keyringPath = path.join(path.dirname(ctx.storePath), 'secrets.keys.json');
  const keys = ce.generateKeys();
  ce.writeKeyring(keys, keyringPath);
  const said = [];
  cm.exportDenoEnv(ctx.storePath, (s) => said.push(String(s)), keyringPath);

  const envPath = path.join(path.dirname(ctx.storePath), 'deno.env');
  assert.ok(fs.existsSync(envPath), 'deno.env is written');
  assert.equal((fs.statSync(envPath).mode & 0o777).toString(8), '600', 'mode is 0600');

  const text = fs.readFileSync(envPath, 'utf8');
  assert.equal(text, `SECRETS_KEY_COMMON=${keys.common}\nSECRETS_KEY_EDGE=${keys.edge}\n`);
  assert.ok(!text.includes(ctx.store.credentials.UUID), 'no decrypted credential is exported');
  assert.ok(!text.includes('WSPATH'), 'only group keys are exported');

  // The announcement carries the path and key names but never the secret itself.
  const announced = said.join('\n');
  assert.ok(!announced.includes(ctx.store.credentials.UUID), 'no secret printed to the terminal');
  assert.ok(!announced.includes(keys.common), 'no group key is printed to the terminal');
  assert.match(announced, /wrote .*deno\.env \(SECRETS_KEY_COMMON, SECRETS_KEY_EDGE\)/);
});

test('the exports require a keyring and write nothing when it is missing', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'creds-')), 'credentials.json');
  const store = cs.emptyStore();
  cs.writeStore(p, store);
  const missing = path.join(path.dirname(p), 'missing.keys.json');

  const said = [];
  cm.exportDenoEnv(p, (s) => said.push(String(s)), missing);
  cm.exportDockerEnv(p, (s) => said.push(String(s)), missing);
  assert.match(said.join('\n'), /--init-keys/);
  assert.ok(!fs.existsSync(path.join(path.dirname(p), 'deno.env')), 'no file is written');
  assert.ok(!fs.existsSync(path.join(path.dirname(p), 'docker.env')), 'no file is written');
});

test('exportDockerEnv writes only Docker\'s two group keys at 0600', () => {
  const ctx = tmpStore();
  const withHost = cs.withField(ctx.store, 'VPS_HOST', 'vps.example.dev');
  cs.writeStore(ctx.storePath, withHost);
  const keyringPath = path.join(path.dirname(ctx.storePath), 'secrets.keys.json');
  const keys = ce.generateKeys();
  ce.writeKeyring(keys, keyringPath);
  const said = [];
  cm.exportDockerEnv(ctx.storePath, (s) => said.push(String(s)), keyringPath);

  const envPath = path.join(path.dirname(ctx.storePath), 'docker.env');
  assert.ok(fs.existsSync(envPath), 'docker.env is written');
  assert.equal((fs.statSync(envPath).mode & 0o777).toString(8), '600', 'mode is 0600');

  const text = fs.readFileSync(envPath, 'utf8');
  assert.equal(text, `SECRETS_KEY_COMMON=${keys.common}\nSECRETS_KEY_SERVER=${keys.server}\n`);
  assert.ok(!text.includes(withHost.credentials.UUID), 'no decrypted credential is exported');
  assert.ok(!text.includes('PUBLIC_HOST'), 'deployment config is no longer part of the key export');

  const announced = said.join('\n');
  assert.ok(!announced.includes(keys.server), 'no group key is printed to the terminal');
  assert.match(announced, /wrote .*docker\.env \(SECRETS_KEY_COMMON, SECRETS_KEY_SERVER\)/);
});

test('the combined TUI export validates the complete keyring before writing either file', () => {
  const ctx = tmpStore();
  const keyringPath = path.join(path.dirname(ctx.storePath), 'secrets.keys.json');
  const keys = ce.generateKeys();
  ce.writeKeyring({ common: keys.common, edge: keys.edge }, keyringPath);
  const said = [];

  assert.equal(cm.exportKeyEnvs(ctx.storePath, (s) => said.push(String(s)), keyringPath), null);
  assert.match(said.join('\n'), /missing server/);
  assert.ok(!fs.existsSync(path.join(path.dirname(ctx.storePath), 'deno.env')));
  assert.ok(!fs.existsSync(path.join(path.dirname(ctx.storePath), 'docker.env')));

  ce.writeKeyring(keys, keyringPath);
  const paths = cm.exportKeyEnvs(ctx.storePath, () => {}, keyringPath);
  assert.equal(paths.length, 2);
  assert.ok(fs.existsSync(path.join(path.dirname(ctx.storePath), 'deno.env')));
  assert.ok(fs.existsSync(path.join(path.dirname(ctx.storePath), 'docker.env')));
});

test('printFrontPin probes and prints FRONT_CERT_PIN plus the cert description', async () => {
  const ctx = tmpStore();
  let s = cs.withField(ctx.store, 'VPS_HOST', 'sync.example.dev');
  s = cs.withField(s, 'FRONT_SNI', 'www.microsoft.com');

  const calls = [];
  const stub = async (host, sni) => {
    calls.push([host, sni]);
    return { pin: 'd'.repeat(64), subject: 'yunohost.org', issuer: 'yunohost.org', validTo: 'Jan 1 2030' };
  };

  const out = [];
  const pin = await cm.printFrontPin(s, (line) => out.push(line), stub);
  const said = out.join('\n');

  assert.deepEqual(calls, [['sync.example.dev', 'www.microsoft.com']], 'probes VPS_HOST with the front SNI');
  assert.equal(pin, 'd'.repeat(64));
  assert.match(said, /^FRONT_CERT_PIN=d{64}$/m, 'prints a ready-to-paste line');
  assert.match(said, /issuer=yunohost\.org/, 'shows the issuer so a MITM cert is obvious');
});

test('printFrontPin warns when the probe returns an interception cert', async () => {
  const ctx = tmpStore();
  let s = cs.withField(ctx.store, 'VPS_HOST', 'sync.example.dev');
  s = cs.withField(s, 'FRONT_SNI', 'www.microsoft.com');

  const stub = async () => ({ pin: 'e'.repeat(64), subject: 'www.microsoft.com', issuer: 'fatihca', validTo: 'x' });
  const out = [];
  await cm.printFrontPin(s, (line) => out.push(line), stub);
  assert.match(out.join('\n'), /interception cert/, 'flags a fatihca issuer');
});

test('printFrontPin needs VPS_HOST and FRONT_SNI and never probes without them', async () => {
  const ctx = tmpStore();   // VPS_HOST / FRONT_SNI unset
  let probed = false;
  const out = [];
  const pin = await cm.printFrontPin(ctx.store, (line) => out.push(line), async () => { probed = true; });

  assert.equal(pin, null);
  assert.equal(probed, false, 'must not touch the network with inputs missing');
  assert.match(out.join('\n'), /set VPS_HOST and FRONT_SNI/);
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
