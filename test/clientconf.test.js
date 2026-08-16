'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildVlessLink, buildXrayConfig } = require('../src/node/clientconf.js');
const { INTERCEPT_CA_PEM } = require('../src/node/interceptca.js');

const ARGS = {
  uuid: 'bb3d6381-f832-4549-b607-541f00917947',
  host: 'edge.example.dev',
  port: 443,
  wsPath: '/e98e9d20785b7f134144a4e2cdeb74fa',
  label: 'alice'
};

test('the share link matches its golden form', () => {
  assert.equal(
    buildVlessLink(ARGS),
    'vless://bb3d6381-f832-4549-b607-541f00917947@edge.example.dev:443' +
    '?encryption=none&security=tls&sni=edge.example.dev&type=ws' +
    '&host=edge.example.dev&path=%2Fe98e9d20785b7f134144a4e2cdeb74fa' +
    '#alice%40edge.example.dev'
  );
});

test('the link omits the three fields that break Xray', () => {
  const link = buildVlessLink(ARGS);
  // alpn breaks the WebSocket upgrade; allowInsecure was removed in v26.2.6 and
  // a config carrying it refuses to start; fp is not configured on any profile.
  assert.ok(!link.includes('alpn'));
  assert.ok(!link.includes('allowInsecure'));
  assert.ok(!link.includes('fp='));
});

test('the link is parseable and carries the credential in the userinfo', () => {
  const url = new URL(buildVlessLink(ARGS));
  assert.equal(url.protocol, 'vless:');
  assert.equal(url.username, ARGS.uuid);
  assert.equal(url.hostname, ARGS.host);
  assert.equal(url.port, '443');
  assert.equal(url.searchParams.get('path'), ARGS.wsPath);
  assert.equal(url.searchParams.get('sni'), ARGS.host);
});

test('the link label falls back to the host when unlabelled', () => {
  assert.ok(buildVlessLink({ ...ARGS, label: '' }).endsWith('#edge.example.dev'));
});

test('the config carries the interception CA by default', () => {
  const conf = buildXrayConfig(ARGS);
  const tls = conf.outbounds[0].streamSettings.tlsSettings;

  assert.deepEqual(tls.certificates[0].certificate, INTERCEPT_CA_PEM);
  assert.equal(tls.certificates[0].usage, 'verify');
  assert.equal(tls.serverName, ARGS.host);

  // A copy, so a caller mutating one config cannot corrupt the baked constant.
  assert.notEqual(tls.certificates[0].certificate, INTERCEPT_CA_PEM);
});

test('an empty CA omits the certificates block entirely', () => {
  const conf = buildXrayConfig({ ...ARGS, ca: [] });
  assert.equal(conf.outbounds[0].streamSettings.tlsSettings.certificates, undefined);
  assert.equal(conf.outbounds[0].streamSettings.tlsSettings.serverName, ARGS.host);
});

test('the config matches the known-good Android profile shape', () => {
  const conf = buildXrayConfig(ARGS);
  const out = conf.outbounds[0];

  assert.equal(conf.inbounds[0].protocol, 'socks');
  assert.equal(conf.inbounds[0].port, 10808);
  assert.equal(conf.inbounds[0].settings.udp, true);
  assert.deepEqual(conf.inbounds[0].sniffing.destOverride, ['http', 'tls']);

  assert.equal(out.protocol, 'vless');
  assert.equal(out.settings.vnext[0].address, ARGS.host);
  assert.equal(out.settings.vnext[0].port, 443);
  assert.equal(out.settings.vnext[0].users[0].id, ARGS.uuid);
  assert.equal(out.settings.vnext[0].users[0].encryption, 'none');

  assert.equal(out.streamSettings.network, 'ws');
  assert.equal(out.streamSettings.security, 'tls');
  assert.equal(out.streamSettings.wsSettings.path, ARGS.wsPath);
  assert.equal(out.streamSettings.wsSettings.host, ARGS.host);
  assert.equal(out.streamSettings.sockopt.domainStrategy, 'UseIPv4');

  assert.equal(out.mux.enabled, true);
  assert.equal(out.mux.concurrency, 8);
  assert.equal(out.mux.xudpConcurrency, 1024);
});

test('the default profile blackholes UDP and rejects QUIC', () => {
  const conf = buildXrayConfig(ARGS);
  assert.equal(conf.routing.rules.find((r) => r.network === 'udp').outboundTag, 'block');
  assert.equal(conf.outbounds[0].mux.xudpProxyUDP443, 'reject');
  assert.ok(conf.outbounds.some((o) => o.protocol === 'blackhole'));
});

test('the udp profile tunnels UDP and allows QUIC', () => {
  const conf = buildXrayConfig({ ...ARGS, udp: true });
  assert.equal(conf.routing.rules.find((r) => r.network === 'udp').outboundTag, 'vless');
  assert.equal(conf.outbounds[0].mux.xudpProxyUDP443, 'allow');
});

test('DNS is routed through the tunnel in both profiles', () => {
  for (const udp of [false, true]) {
    const rule = buildXrayConfig({ ...ARGS, udp }).routing.rules[0];
    assert.equal(rule.port, '53');
    assert.equal(rule.outboundTag, 'vless');
  }
});

test('the config serialises to valid JSON with no forbidden fields', () => {
  const json = JSON.stringify(buildXrayConfig(ARGS));
  assert.deepEqual(JSON.parse(json).outbounds[0].settings.vnext[0].users[0].id, ARGS.uuid);
  assert.ok(!json.includes('allowInsecure'));
  assert.ok(!json.includes('alpn'));
  assert.ok(!json.includes('pinnedPeerCertSha256'));
});

test('the baked CA is the fatihca root and is well-formed PEM', () => {
  assert.equal(INTERCEPT_CA_PEM[0], '-----BEGIN CERTIFICATE-----');
  assert.equal(INTERCEPT_CA_PEM[INTERCEPT_CA_PEM.length - 1], '-----END CERTIFICATE-----');
  assert.ok(INTERCEPT_CA_PEM.length > 10);
  for (const line of INTERCEPT_CA_PEM) assert.ok(!line.includes('\n'));
});
