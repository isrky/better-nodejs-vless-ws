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
async function mint(port, cookie, label = 'alice') {
  const body = (await bodyOf(port, `/admin-stats/provision?label=${label}`, 'GET', cookie)).toString();
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
  assert.ok(body.includes(`vless://${uuid}@edge.example.dev:443`));
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

test('the reveal page offers exactly one config download', async (t) => {
  // Two buttons was the footgun: the prominent one was the broken one.
  const srv = await start();
  t.after(() => srv.close());
  const token = await mint(srv.port, await login(srv.port));

  const { body } = await fetchOf(srv.port, `/i/${token}/show`);
  const html = body.toString();
  assert.equal((html.match(/conf\.json/g) || []).length, 1);
  assert.ok(!html.includes('udp=1'), 'the escape hatch stays unadvertised');
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
  const srv = await start();
  t.after(() => srv.close());
  const token = await mint(srv.port, await login(srv.port));

  const body = (await bodyOf(srv.port, `/i/${token}/show`)).toString();
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
    label: hostile, link: 'vless://x@y:443', confUrl: '/a'
  });
  assert.ok(!reveal.includes('</script><script>alert'));
  assert.ok(!reveal.includes('<img onerror'));
});
