'use strict';

// Provisioning routes.
//
// The property under test throughout: anything that is not a correctly signed,
// still-valid request must be byte-identical to `GET /`. Provisioning is the
// most attractive thing on this server to find, so its existence must not be
// discoverable by probing.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createServer } = require('../src/node/server.js');
const { loadConfig } = require('../src/node/config.js');
const { deriveUser } = require('../src/node/users.js');
const { subkey, mintInvite } = require('../src/node/tokens.js');
const { FAKE_INDEX_HTML } = require('../src/decoy.js');
const { rawRequest, rawRequestUntil, splitResponse } = require('./helpers/rawclient.js');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DECOY = sha256(FAKE_INDEX_HTML);

const SECRET = 'fixed-test-secret-0123456789abcd';
const ENV = {
  ADMIN_TOKEN: 's3cret',
  PROVISION_SECRET: SECRET,
  USERS: 'alice,bob',
  PUBLIC_HOST: 'edge.example.dev',
  WSPATH: '/tunnel'
};

function start(env = ENV) {
  return new Promise((resolve) => {
    const handle = createServer({ config: loadConfig(env), logger: () => {} });
    const open = new Set();
    handle.server.on('connection', (s) => {
      open.add(s);
      s.on('close', () => open.delete(s));
    });
    handle.server.listen(0, '127.0.0.1', () => resolve({
      port: handle.server.address().port,
      handle,
      close: () => new Promise((done) => {
        handle.close(done);
        for (const s of open) s.destroy();
      })
    }));
  });
}

function request(path, method = 'GET', cookie = '') {
  return `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
         (cookie ? `Cookie: ${cookie}\r\n` : '') + '\r\n';
}

async function fetchOf(port, path, method = 'GET', cookie = '') {
  return splitResponse(await rawRequest(port, request(path, method, cookie)));
}

async function bodyOf(port, path, method = 'GET', cookie = '') {
  return (await fetchOf(port, path, method, cookie)).body;
}

/** Trade the bootstrap token for a session cookie. */
async function login(port) {
  const { head } = await fetchOf(port, '/admin-stats?token=s3cret');
  return head.match(/Set-Cookie: ([^;]+);/)[1];
}

/** Mint an invite through the UI and return its token. */
async function mint(port, cookie, label = 'alice', udp = false) {
  // Returns the tail after /i/ — the token, plus ?udp=1 when the operator asked
  // for it, because that query is part of what gets handed over.
  const q = `?label=${label}` + (udp ? '&udp=1' : '');
  const body = (await bodyOf(port, `/admin-stats/provision${q}`, 'GET', cookie)).toString();
  const m = body.match(/id="qr-data">([^<]*)</);
  assert.ok(m, 'the provision page must show an invite URL');
  return m[1].split('/i/')[1];
}

test('the provision page is gated exactly like the rest of the admin panel', async (t) => {
  const srv = await start();
  t.after(() => srv.close());

  for (const [path, method, cookie] of [
    ['/admin-stats/provision', 'GET', ''],
    ['/admin-stats/provision?token=wrong', 'GET', ''],
    ['/admin-stats/provision?token=', 'GET', ''],
    ['/admin-stats/provision', 'GET', 'adm=garbage'],
    ['/admin-stats/provision?label=alice', 'GET', ''],
    ['/admin-stats/provision?token=s3cret', 'POST', ''],
    ['/Admin-Stats/Provision?token=s3cret', 'GET', ''],
    ['/admin-stats/provision-x?token=s3cret', 'GET', '']
  ]) {
    assert.equal(sha256(await bodyOf(srv.port, path, method, cookie)), DECOY,
      `${method} ${path} must be gated`);
  }
});

test('an unknown or reserved label mints nothing and reveals nothing', async (t) => {
  const srv = await start();
  t.after(() => srv.close());
  const cookie = await login(srv.port);

  for (const label of ['carol', 'owner', 'ALICE', '../x', '<script>']) {
    const path = `/admin-stats/provision?label=${encodeURIComponent(label)}`;
    assert.equal(sha256(await bodyOf(srv.port, path, 'GET', cookie)), DECOY, label);
  }
});

test('the provision page lists configured users but never the owner or a UUID', async (t) => {
  const srv = await start();
  t.after(() => srv.close());

  const html = (await bodyOf(srv.port, '/admin-stats/provision', 'GET', await login(srv.port))).toString();

  assert.match(html, /<option value="alice">/);
  assert.match(html, /<option value="bob">/);
  assert.ok(!html.includes('owner'), 'the operator credential must not be mintable');
  assert.ok(!html.includes(deriveUser(SECRET, 'alice').uuid), 'no credential on the picker');
  assert.ok(!html.includes(SECRET));
  assert.ok(!html.includes('s3cret'));
});

test('with PROVISION_SECRET unset every provisioning route is the decoy', async (t) => {
  const srv = await start({ ADMIN_TOKEN: 's3cret', USERS: 'alice', WSPATH: '/tunnel' });
  t.after(() => srv.close());
  const cookie = await login(srv.port);

  assert.equal(sha256(await bodyOf(srv.port, '/admin-stats/provision', 'GET', cookie)), DECOY);
  assert.equal(sha256(await bodyOf(srv.port, '/i/anything', 'GET', cookie)), DECOY);
  assert.equal(sha256(await bodyOf(srv.port, '/i/anything/show', 'GET', cookie)), DECOY);

  // The dashboard itself still works — only provisioning is off.
  assert.match((await bodyOf(srv.port, '/admin-stats', 'GET', cookie)).toString(),
    /Server Statistics Dashboard/);
});

test('a forged, malformed or truncated invite is indistinguishable from GET /', async (t) => {
  const srv = await start();
  t.after(() => srv.close());
  const token = await mint(srv.port, await login(srv.port));

  for (const bad of [
    token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'),
    token.replace('.alice.', '.bob.'),
    token.slice(0, 12),
    'garbage',
    '',
    'x'.repeat(300)
  ]) {
    for (const suffix of ['', '/show', '/conf.json']) {
      assert.equal(sha256(await bodyOf(srv.port, `/i/${bad}${suffix}`)), DECOY,
        `/i/${bad.slice(0, 20)}${suffix}`);
    }
  }
});

test('an unknown action under a valid token is the decoy', async (t) => {
  const srv = await start();
  t.after(() => srv.close());
  const token = await mint(srv.port, await login(srv.port));

  for (const action of ['/conf', '/show/x', '/conf.json/x', '/../admin-stats']) {
    assert.equal(sha256(await bodyOf(srv.port, `/i/${token}${action}`)), DECOY, action);
  }
});

test('an expired invite gets a real page, not the decoy', async (t) => {
  const srv = await start();
  t.after(() => srv.close());

  // A correct signature proves the operator minted it, so telling that holder
  // it expired discloses nothing they did not already know.
  const key = subkey(SECRET, 'invite-key-v1');
  const { token } = mintInvite(key, 'alice', 900, 'nonce123', () => Date.now() - 3600_000);

  const body = (await bodyOf(srv.port, `/i/${token}/show`)).toString();
  assert.notEqual(sha256(body), DECOY);
  assert.match(body, /no longer valid/);
  assert.ok(!body.includes('alice'), 'and it must not confirm who the invite was for');
});

test('the landing page carries no credential, so preview bots cannot burn it', async (t) => {
  const srv = await start();
  t.after(() => srv.close());
  const token = await mint(srv.port, await login(srv.port));
  const uuid = deriveUser(SECRET, 'alice').uuid;

  // Fetch it repeatedly, the way a chat client would.
  for (let i = 0; i < 3; i++) {
    const body = (await bodyOf(srv.port, `/i/${token}`)).toString();
    assert.match(body, /Your connection is ready/);
    assert.ok(!body.includes(uuid), 'the landing page must never carry the credential');
    assert.ok(!body.includes('vless://'));
  }

  // And the reveal still works afterwards.
  assert.match((await bodyOf(srv.port, `/i/${token}/show`)).toString(), /Set up alice/);
});

test('the reveal page hands over exactly the derived credential', async (t) => {
  const srv = await start();
  t.after(() => srv.close());
  const token = await mint(srv.port, await login(srv.port));

  const body = (await bodyOf(srv.port, `/i/${token}/show`)).toString();
  const uuid = deriveUser(SECRET, 'alice').uuid;

  assert.match(body, /Set up alice/);
  assert.ok(body.includes(uuid), 'the page carries their own credential, in the config');
  assert.ok(!body.includes(SECRET), 'the master secret must never be rendered');
  assert.ok(!body.includes('s3cret'));
  assert.ok(!body.includes(deriveUser(SECRET, 'bob').uuid), 'nor anyone else s credential');
});

test('the config download is a valid Xray profile for that user', async (t) => {
  const srv = await start();
  t.after(() => srv.close());
  const token = await mint(srv.port, await login(srv.port));

  const { head, body } = await fetchOf(srv.port, `/i/${token}/conf.json`);
  assert.match(head, /Content-Type: application\/json/);
  assert.match(head, /Content-Disposition: attachment; filename="vless-alice\.json"/);
  assert.match(head, /Referrer-Policy: no-referrer/);

  const conf = JSON.parse(body.toString());
  const out = conf.outbounds[0];
  assert.equal(out.settings.vnext[0].users[0].id, deriveUser(SECRET, 'alice').uuid);
  assert.equal(out.settings.vnext[0].address, 'edge.example.dev');
  assert.equal(out.streamSettings.wsSettings.path, '/tunnel');
  assert.ok(out.streamSettings.tlsSettings.certificates[0].certificate.length > 10,
    'the interception CA is what a share link cannot carry');
});

test('the default download carries UDP but refuses QUIC', async (t) => {
  // The regression this exists for: the old default blackholed all UDP, so a
  // provisioned device browsed fine and could not use Roblox or Discord voice
  // — a failure nobody notices until days later.
  const srv = await start();
  t.after(() => srv.close());
  const token = await mint(srv.port, await login(srv.port));

  const { body } = await fetchOf(srv.port, `/i/${token}/conf.json`);
  const rules = JSON.parse(body.toString()).routing.rules;

  const catchAll = rules.find((r) => r.network === 'udp' && r.port === undefined);
  const quic = rules.find((r) => r.network === 'udp' && r.port === '443');
  assert.equal(catchAll.outboundTag, 'vless', 'games and voice must reach the tunnel');
  assert.equal(quic.outboundTag, 'block');
  assert.ok(rules.indexOf(quic) < rules.indexOf(catchAll), 'Xray matches first-wins');
});

test('?udp=1 is still there for anyone who wants QUIC tunnelled too', async (t) => {
  const srv = await start();
  t.after(() => srv.close());
  const token = await mint(srv.port, await login(srv.port));

  const { head, body } = await fetchOf(srv.port, `/i/${token}/conf.json?udp=1`);
  assert.match(head, /filename="vless-alice-udp\.json"/);

  const conf = JSON.parse(body.toString());
  assert.equal(conf.routing.rules.find((r) => r.network === 'udp' && r.port === undefined).outboundTag, 'vless');
  assert.ok(!conf.routing.rules.some((r) => r.port === '443'), 'no rule to block QUIC');
  assert.equal(conf.outbounds[0].mux.xudpProxyUDP443, 'allow');
});

test('the reveal page offers exactly one config download, either way', async (t) => {
  // Two buttons was the footgun: the prominent one was the broken one. The
  // operator's toggle must not put the choice back in front of the invitee —
  // the invariant is ONE button, not "never QUIC".
  const srv = await start();
  t.after(() => srv.close());
  const cookie = await login(srv.port);

  for (const udp of [false, true]) {
    const tail = await mint(srv.port, cookie, 'alice', udp);
    const { body } = await fetchOf(srv.port, `/i/${tail.split('?')[0]}/show${udp ? '?udp=1' : ''}`);
    const html = body.toString();

    assert.equal((html.match(/conf\.json/g) || []).length, 1, `udp=${udp}: one download only`);
    assert.equal(html.includes('udp=1'), udp, `udp=${udp}: the query is carried, not offered`);
  }
});

test('the operator toggle rides the invite URL through every hop', async (t) => {
  // Landing -> show -> conf.json. Dropping the query at any one hop silently
  // serves the other policy, and the file still looks plausible.
  const srv = await start();
  t.after(() => srv.close());
  const cookie = await login(srv.port);

  const tail = await mint(srv.port, cookie, 'alice', true);
  assert.match(tail, /\?udp=1$/, 'the minted invite URL carries the toggle');
  const token = tail.split('?')[0];

  const landing = (await fetchOf(srv.port, `/i/${token}?udp=1`)).body.toString();
  assert.match(landing, /\/show\?udp=1/, 'the landing page must pass it on');

  const reveal = (await fetchOf(srv.port, `/i/${token}/show?udp=1`)).body.toString();
  assert.match(reveal, /conf\.json\?udp=1/, 'and the reveal page must too');
});

// ---------- domain fronting ----------

const FRONT_PIN = 'c'.repeat(64);
const FRONT_ENV = { ...ENV, FRONT_SNI: 'www.microsoft.com' };

// Inject a stub pin provider so nothing touches the network. `pin` is what
// get() resolves to — a hex string when the edge is reachable, null when not.
function startFront(pin = FRONT_PIN) {
  return new Promise((resolve) => {
    const handle = createServer({
      config: loadConfig(FRONT_ENV),
      logger: () => {},
      frontPin: { get: async () => pin, stop() {} }
    });
    const open = new Set();
    handle.server.on('connection', (s) => { open.add(s); s.on('close', () => open.delete(s)); });
    handle.server.listen(0, '127.0.0.1', () => resolve({
      port: handle.server.address().port,
      handle,
      close: () => new Promise((done) => { handle.close(done); for (const s of open) s.destroy(); })
    }));
  });
}

async function mintFront(port, cookie, label = 'alice') {
  const body = (await bodyOf(port, `/admin-stats/provision?label=${label}&front=1`, 'GET', cookie)).toString();
  const m = body.match(/id="qr-data">([^<]*)</);
  assert.ok(m, 'the provision page must show an invite URL');
  return m[1].split('/i/')[1];
}

test('?front=1 serves a spoofed-SNI, cert-pinned config when the edge is reachable', async (t) => {
  const srv = await startFront(FRONT_PIN);
  t.after(() => srv.close());
  const token = (await mintFront(srv.port, await login(srv.port))).split('?')[0];

  const { head, body } = await fetchOf(srv.port, `/i/${token}/conf.json?front=1`);
  assert.match(head, /filename="vless-alice-fronted\.json"/);

  const tls = JSON.parse(body.toString()).outbounds[0].streamSettings.tlsSettings;
  assert.equal(tls.serverName, 'www.microsoft.com', 'the SNI is spoofed');
  assert.equal(tls.pinnedPeerCertSha256, FRONT_PIN);
  assert.equal(tls.certificates, undefined, 'no CA block when pinning');

  const out = JSON.parse(body.toString()).outbounds[0];
  assert.equal(out.settings.vnext[0].address, 'edge.example.dev', 'address stays real');
  assert.equal(out.streamSettings.wsSettings.host, 'edge.example.dev', 'Host stays real');
});

test('front falls back to the standard config when the pin probe fails', async (t) => {
  const srv = await startFront(null);   // edge unreachable -> get() resolves null
  t.after(() => srv.close());
  const token = (await mintFront(srv.port, await login(srv.port))).split('?')[0];

  const { head, body } = await fetchOf(srv.port, `/i/${token}/conf.json?front=1`);
  assert.match(head, /filename="vless-alice\.json"/, 'no -fronted suffix on fallback');
  const tls = JSON.parse(body.toString()).outbounds[0].streamSettings.tlsSettings;
  assert.equal(tls.serverName, 'edge.example.dev', 'standard SNI');
  assert.ok(tls.certificates, 'standard CA block is present');
  assert.equal(tls.pinnedPeerCertSha256, undefined);

  // Reveal a fresh invite to check the fallback note (the first burned its nonce).
  const token2 = (await mintFront(srv.port, await login(srv.port))).split('?')[0];
  const reveal = (await fetchOf(srv.port, `/i/${token2}/show?front=1`)).body.toString();
  assert.match(reveal, /Fronting unavailable/, 'the invitee is told they got the standard profile');
});

test('the front toggle rides the invite URL through every hop', async (t) => {
  const srv = await startFront(FRONT_PIN);
  t.after(() => srv.close());
  const cookie = await login(srv.port);

  const tail = await mintFront(srv.port, cookie);
  assert.match(tail, /\?front=1$/, 'the minted invite URL carries the toggle');
  const token = tail.split('?')[0];

  const landing = (await fetchOf(srv.port, `/i/${token}?front=1`)).body.toString();
  assert.match(landing, /\/show\?front=1/, 'landing passes it on');
  const reveal = (await fetchOf(srv.port, `/i/${token}/show?front=1`)).body.toString();
  assert.match(reveal, /conf\.json\?front=1/, 'and the reveal page too');
});

test('front is inert when FRONT_SNI is not configured', async (t) => {
  // Same ?front=1, but a server with no FRONT_SNI must serve the standard config
  // and never advertise fronting.
  const srv = await start();
  t.after(() => srv.close());
  const token = await mint(srv.port, await login(srv.port));

  const { head, body } = await fetchOf(srv.port, `/i/${token}/conf.json?front=1`);
  assert.match(head, /filename="vless-alice\.json"/);
  assert.equal(JSON.parse(body.toString()).outbounds[0].streamSettings.tlsSettings.serverName,
    'edge.example.dev');
});

test('without the toggle nothing downstream mentions it', async (t) => {
  const srv = await start();
  t.after(() => srv.close());

  const tail = await mint(srv.port, await login(srv.port));
  assert.ok(!tail.includes('udp'), 'a plain mint yields a bare invite URL');
});

test('the provision form offers the toggle', async (t) => {
  const srv = await start();
  t.after(() => srv.close());

  const html = (await bodyOf(srv.port, '/admin-stats/provision', 'GET', await login(srv.port))).toString();
  assert.match(html, /name="udp" value="1"/);
  assert.match(html, /type="checkbox"/);
});

test('a revoked user reads exactly like an expired invite', async (t) => {
  const srv = await start();
  t.after(() => srv.close());
  const token = await mint(srv.port, await login(srv.port));

  // Same secret, but alice is no longer in USERS — as after a revoking deploy.
  const revoked = await start({ ...ENV, USERS: 'bob' });
  t.after(() => revoked.close());

  const body = (await bodyOf(revoked.port, `/i/${token}/show`)).toString();
  assert.notEqual(sha256(body), DECOY);
  assert.match(body, /no longer valid/);
  assert.ok(!body.includes('alice'), 'must not confirm the label ever existed');
});

test('the QR script is pinned by exact version and SRI', async (t) => {
  // The QR now lives only on the operator's page: the invitee page dropped the
  // share link it used to encode, so it no longer loads this script at all.
  const srv = await start();
  t.after(() => srv.close());

  const body = (await bodyOf(srv.port, '/admin-stats/provision?label=alice',
    'GET', await login(srv.port))).toString();
  assert.match(body, /qrcode-generator@1\.4\.4\/qrcode\.js/, 'exact version, never a range');
  assert.match(body, /integrity="sha384-[A-Za-z0-9+/=]+"/);
  assert.match(body, /crossorigin="anonymous"/);
  assert.ok(!body.includes('.min.js'), 'jsDelivr minifies on the fly; SRI would break');
});

test('provisioning pages never use innerHTML', async (t) => {
  const srv = await start();
  t.after(() => srv.close());
  const cookie = await login(srv.port);
  const token = await mint(srv.port, cookie);

  for (const path of ['/admin-stats/provision', `/i/${token}`, `/i/${token}/show`]) {
    const body = (await bodyOf(srv.port, path, 'GET', cookie)).toString();
    assert.ok(!body.includes('innerHTML'), path);
  }
});

test('a WSPATH overlapping the invite prefix still upgrades', async (t) => {
  // The invite router is the one prefix match in the dispatch, and WSPATH is
  // matched by substring — without the upgrade guard, every tunnel on such a
  // path would be silently swallowed and served the decoy.
  const srv = await start({ ...ENV, WSPATH: '/i/tunnel' });
  t.after(() => srv.close());

  // rawRequestUntil, not rawRequest: a successful upgrade leaves the socket
  // open forever, and reading until close would hang the runner.
  const raw = await rawRequestUntil(srv.port,
    'GET /i/tunnel HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    (buf) => buf.includes('\r\n\r\n'), 4000);

  assert.match(raw.toString('utf8', 0, 40), /^HTTP\/1\.1 101 Switching Protocols/,
    'the tunnel must win over the invite prefix');
});

test('a hostile label cannot break out of the page or the filename', async (t) => {
  // Reach past validation and call the renderers directly: escaping must hold
  // even if a label ever gets through by another route.
  const { renderProvisionPage, renderRevealPage } = require('../src/node/provision-pages.js');
  const hostile = '</script><script>alert(1)</script>"><img onerror=x>';

  const picker = renderProvisionPage({ labels: [hostile], adminPath: '/admin-stats/provision' });
  assert.ok(!picker.includes('</script><script>alert'));
  assert.ok(!picker.includes('<img onerror'));

  const reveal = renderRevealPage({
    label: hostile, confUrl: '/a', configJson: `{"note": "${hostile}"}`
  });
  assert.ok(!reveal.includes('</script><script>alert'));
  assert.ok(!reveal.includes('<img onerror'));
});

// ---------- the invitee page is one artefact ----------

/** Pull the embedded config out of the reveal page. */
function embedded(html) {
  const m = html.match(/<code id="conf-json">([\s\S]*?)<\/code>/);
  assert.ok(m, 'the reveal page must embed the config');
  return m[1]
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

test('the copy button and the download hand over identical bytes', async (t) => {
  // Two build sites that could disagree is the failure this area keeps
  // producing, so assert the bytes rather than the shape.
  const srv = await start();
  t.after(() => srv.close());
  const cookie = await login(srv.port);

  for (const udp of [false, true]) {
    const tail = await mint(srv.port, cookie, 'alice', udp);
    const token = tail.split('?')[0];
    const q = udp ? '?udp=1' : '';

    const page = (await bodyOf(srv.port, `/i/${token}/show${q}`)).toString();
    const download = (await bodyOf(srv.port, `/i/${token}/conf.json${q}`)).toString();

    assert.equal(embedded(page), download, `udp=${udp}: copy and download disagree`);
    assert.doesNotThrow(() => JSON.parse(embedded(page)));
  }
});

test('the invitee page no longer offers a share link or loads the QR CDN', async (t) => {
  // The vless:// URI has no slot for a certificate, so on a TLS-inspecting
  // network it was the prominent option that could not work.
  const srv = await start();
  t.after(() => srv.close());
  const token = await mint(srv.port, await login(srv.port));

  const page = (await bodyOf(srv.port, `/i/${token}/show`)).toString();
  assert.ok(!page.includes('vless://'), 'no share link');
  assert.ok(!page.includes('<canvas'), 'no QR canvas');
  assert.ok(!page.includes('qrcode-generator'), 'and no CDN script for one');
  assert.match(page, /data-copy="conf-json"/, 'but it can be copied');
});
