'use strict';

// The committed client-config templates and the renderer that fills them in.
//
// Two guarantees carry this file:
//
//   * the templates cannot contain a credential — a leak guard greps every
//     committed template for anything that looks like one, which catches the
//     obvious accident of pasting a rendered config back into templates/;
//   * the android template renders to exactly what buildXrayConfig() produces
//     server-side for provisioning, so the two copies of that shape cannot
//     drift apart silently.
//
// Nothing here reads local/, so the suite passes on a fresh clone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildXrayConfig } = require('../src/node/clientconf.js');
const { INTERCEPT_CA_PEM } = require('../src/node/interceptca.js');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_DIR = path.join(ROOT, 'templates');

const KNOWN = ['UUID', 'WSPATH', 'HOST', 'UDP_OUTBOUND', 'QUIC_OUTBOUND', 'XUDP_443', 'CA_PEM_LINES'];

// Deliberately fake, and shaped so it cannot be mistaken for a real credential:
// an all-zero UUID and a ws path that is literal words rather than hex. Both are
// allowlisted by the credential guard below, so adding a fixture value forces an
// edit there — which is the review moment you want.
const FIXTURE = {
  uuid: '00000000-0000-4000-8000-000000000001',
  host: 'edge.example.dev',
  wsPath: '/test-ws-path-not-a-real-one'
};

const templateFiles = () => fs.readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.json'));

let renderer;
test.before(async () => {
  renderer = await import('../tools/render-configs.mjs');
});

test('there are templates, and every one is valid JSON', () => {
  const files = templateFiles();
  assert.ok(files.length >= 2, 'expected at least the linux and android templates');
  for (const file of files) {
    assert.doesNotThrow(
      () => JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8')),
      `${file} must stay parseable so editors and CI can lint it`
    );
  }
});

test('templates use only known placeholders', () => {
  for (const file of templateFiles()) {
    const text = fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8');
    for (const [, name] of text.matchAll(/\$\{([A-Z0-9_]+)\}/g)) {
      assert.ok(KNOWN.includes(name), `${file}: unknown placeholder \${${name}}`);
    }
    // Templates must stay deployment-agnostic: the renderer resolves HOST per
    // profile, so a template naming an env var directly would not substitute.
    assert.ok(!text.includes('FLY_HOST'), `${file} must not name an env var`);
    assert.ok(!text.includes('WORKER_HOST'), `${file} must not name an env var`);
    assert.ok(!text.includes('DENO_HOST'), `${file} must not name an env var`);
  }
});

test('no committed template contains a credential', () => {
  // The accident this guards: rendering, debugging, and pasting the result back
  // into templates/ — which would commit a live UUID and hostname.
  for (const file of templateFiles()) {
    const text = fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8');

    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(text),
      `${file} contains something shaped like a UUID`);
    assert.ok(!text.includes('-----BEGIN'),
      `${file} contains a certificate; it must use the \${CA_PEM_LINES} marker`);

    for (const line of text.split('\n')) {
      const value = (line.match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1));
      for (const v of value) {
        assert.ok(!/^[A-Za-z0-9+/]{40,}={0,2}$/.test(v), `${file}: base64-looking literal`);
        // 1.1.1.1 and 127.0.0.1 are the only dotted literals a template may hold.
        if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v) && !['1.1.1.1', '127.0.0.1'].includes(v)) {
          assert.fail(`${file}: real-looking hostname "${v}"`);
        }
      }
    }
  }
});

test('the android template renders exactly what buildXrayConfig produces', () => {
  // Same shape, two implementations: this one for the operator's own configs,
  // buildXrayConfig for the invitee configs the server hands out. Host and the
  // udp policy are inputs to both, so a full deepEqual is correct — nothing to
  // exclude. All three policies, so the drop-the-redundant-rule logic in the
  // renderer and the emit-only-for-noquic logic in buildXrayConfig cannot
  // disagree.
  for (const udpPolicy of ['none', 'noquic', 'all']) {
    const rendered = renderer.renderProfile({
      template: 'android-socks.json',
      host: FIXTURE.host,
      udpPolicy,
      uuid: FIXTURE.uuid,
      wsPath: FIXTURE.wsPath,
      caLines: INTERCEPT_CA_PEM
    });

    const built = buildXrayConfig({
      uuid: FIXTURE.uuid,
      host: FIXTURE.host,
      port: 443,
      wsPath: FIXTURE.wsPath,
      udpPolicy
    });

    assert.deepEqual(rendered, built, `${udpPolicy}: template and buildXrayConfig disagree`);
  }
});

test('rendering substitutes every placeholder', () => {
  for (const template of templateFiles()) {
    const config = renderer.renderProfile({
      template, host: FIXTURE.host, udpPolicy: 'none',
      uuid: FIXTURE.uuid, wsPath: FIXTURE.wsPath, caLines: INTERCEPT_CA_PEM
    });
    assert.ok(!JSON.stringify(config).includes('${'), `${template}: placeholder survived`);
  }
});

test('the udp policy drives every half of the udp axis together', () => {
  const expected = {
    none:   { catchAll: 'block', quic: undefined, xudp: 'reject' },
    noquic: { catchAll: 'vless', quic: 'block',   xudp: 'reject' },
    all:    { catchAll: 'vless', quic: undefined, xudp: 'allow' }
  };

  for (const [udpPolicy, want] of Object.entries(expected)) {
    const config = renderer.renderProfile({
      template: 'linux-tproxy.json', host: FIXTURE.host, udpPolicy,
      uuid: FIXTURE.uuid, wsPath: FIXTURE.wsPath, caLines: INTERCEPT_CA_PEM
    });
    const rules = config.routing.rules;
    const catchAll = rules.find((r) => r.network === 'udp' && r.port === undefined);
    const quic = rules.find((r) => r.network === 'udp' && r.port === '443');

    assert.equal(catchAll.outboundTag, want.catchAll, udpPolicy);
    assert.equal(quic && quic.outboundTag, want.quic, `${udpPolicy}: udp/443 rule`);
    assert.equal(config.outbounds[0].mux.xudpProxyUDP443, want.xudp, udpPolicy);
    // A rule left with an empty outboundTag would be silently ignored by Xray.
    for (const r of rules) assert.ok(r.outboundTag, `${udpPolicy}: rule with no outbound survived`);
  }
});

test('the CA splices in as separate lines, and an empty CA drops the block', () => {
  const withCa = renderer.renderProfile({
    template: 'android-socks.json', host: FIXTURE.host, udpPolicy: 'none',
    uuid: FIXTURE.uuid, wsPath: FIXTURE.wsPath, caLines: INTERCEPT_CA_PEM
  });
  const cert = withCa.outbounds[0].streamSettings.tlsSettings.certificates[0].certificate;
  assert.deepEqual(cert, INTERCEPT_CA_PEM, 'the marker must expand to one element per line');

  const without = renderer.renderProfile({
    template: 'android-socks.json', host: FIXTURE.host, udpPolicy: 'none',
    uuid: FIXTURE.uuid, wsPath: FIXTURE.wsPath, caLines: []
  });
  assert.equal('certificates' in without.outbounds[0].streamSettings.tlsSettings, false);
  assert.equal(without.outbounds[0].streamSettings.tlsSettings.serverName, FIXTURE.host);
});

test('the three host fields always agree', () => {
  // A mismatch is a Cloudflare 403 with no upgrade, which reads as a network
  // fault rather than a config error.
  for (const template of templateFiles()) {
    const out = renderer.renderProfile({
      template, host: FIXTURE.host, udpPolicy: 'none',
      uuid: FIXTURE.uuid, wsPath: FIXTURE.wsPath, caLines: INTERCEPT_CA_PEM
    }).outbounds[0];

    assert.equal(out.settings.vnext[0].address, FIXTURE.host);
    assert.equal(out.streamSettings.tlsSettings.serverName, FIXTURE.host);
    assert.equal(out.streamSettings.wsSettings.host, FIXTURE.host);
  }
});

// The dotenv parser these tests used to cover now lives in tools/credstore.mjs
// as parseLegacyEnv, and is exercised in test/credstore.test.js — it survives
// only to import the retired local/.env.

test('normaliseWsPath yields exactly one leading slash', () => {
  // WSPATH in the store already starts with '/', and the same string is what
  // gets pushed to `fly secrets set`, so the renderer normalises at render time
  // rather than rewriting the stored value.
  assert.equal(renderer.normaliseWsPath('/abc'), '/abc');
  assert.equal(renderer.normaliseWsPath('abc'), '/abc');
  assert.equal(renderer.normaliseWsPath('///abc'), '/abc');
  assert.equal(renderer.normaliseWsPath('  /abc  '), '/abc');
  assert.equal(renderer.normaliseWsPath('/abc?ed=2048'), '/abc?ed=2048', 'query survives');

  assert.throws(() => renderer.normaliseWsPath(''));
  assert.throws(() => renderer.normaliseWsPath('/a b'));
  assert.throws(() => renderer.normaliseWsPath('/a#b'), undefined, '# truncates the path');
});

// ---------- profiles ----------

test('the profile table covers both templates and both udp modes', () => {
  const { PROFILES } = renderer;
  assert.equal(PROFILES.length, 8);
  assert.equal(new Set(PROFILES.map((p) => p.out)).size, 8, 'no duplicate outputs');
  assert.equal(PROFILES.filter((p) => p.udp).length, 4);

  for (const p of PROFILES) {
    assert.ok(templateFiles().includes(p.template), `${p.out}: unknown template ${p.template}`);
    assert.ok(['FLY_HOST', 'WORKER_HOST', 'DENO_HOST', 'VPS_HOST'].includes(p.hostVar));
    assert.ok(p.out.startsWith('local/'));
  }

  // tools/qr.mjs hardcodes this exact path as its default and embeds the bare
  // filename in the URL it serves.
  assert.ok(PROFILES.some((p) => p.out === 'local/conf-android.json'),
    'qr.mjs depends on this filename');

  // Only the Node-runtime hosts (Fly, the VPS) carry UDP; the Worker and Deno
  // targets never do.
  for (const p of PROFILES) {
    if (p.udp) {
      assert.ok(['FLY_HOST', 'VPS_HOST'].includes(p.hostVar),
        `${p.out}: udp requires a Node-runtime host`);
    }
    if (p.hostVar === 'DENO_HOST') assert.equal(p.udp, false, `${p.out}: Deno carries no UDP`);
    if (p.hostVar === 'WORKER_HOST') assert.equal(p.udp, false, `${p.out}: the Worker carries no UDP`);
  }
});
