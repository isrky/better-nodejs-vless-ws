'use strict';

// Client artefacts handed to a provisioned user: a vless:// share link and a
// complete Xray config.
//
// Both are needed, and the reason is the whole shape of the invite page:
//
//   * The link is one tap on a phone — v2rayNG and sing-box register the
//     scheme — but the vless:// URI format has NO slot for a certificate, so
//     it cannot carry the interception CA.
//   * The JSON can carry the CA, so it is the only thing that works on a
//     network that terminates and re-signs TLS.
//
// Pure and dependency-free: no I/O, no env reads, no clock.

const { INTERCEPT_CA_PEM } = require('./interceptca.js');

/**
 * Build a v2rayNG/sing-box-compatible share link.
 *
 * Field order is kept byte-identical to the one tools/qr.mjs has always
 * produced, and pinned by a golden test.
 *
 * Three fields are deliberately never emitted:
 *   alpn  — Xray's WebSocket dialer already pins http/1.1; setting
 *           ["h2","http/1.1"] breaks the upgrade outright.
 *   fp    — no fingerprint is configured on any of our profiles.
 *   allowInsecure — removed in Xray v26.2.6; a config carrying it refuses to
 *           start rather than warning.
 */
function buildVlessLink({ uuid, host, port = 443, wsPath = '/', label = '' }) {
  const params = new URLSearchParams();
  params.set('encryption', 'none');
  params.set('security', 'tls');
  params.set('sni', host);
  params.set('type', 'ws');
  params.set('host', host);
  params.set('path', wsPath);

  const tag = label ? `${label}@${host}` : host;
  return `vless://${uuid}@${host}:${port}?${params.toString()}#${encodeURIComponent(tag)}`;
}

/**
 * Build a complete Xray client config.
 *
 * The Android/SOCKS shape, because this is the mobile target and it is the
 * profile already known to work on the intercepting network.
 *
 * `udpPolicy` selects the routing policy for UDP:
 *
 *   'noquic' (default) — UDP is tunnelled, except port 443. Games and voice
 *     chat work; browsers are pushed off QUIC and onto TCP/TLS.
 *   'none' — everything but DNS is blackholed locally.
 *   'all' — every UDP goes through, QUIC included, with xudpProxyUDP443
 *     "allow". Only useful against a server that carries arbitrary UDP.
 *
 * Blocking UDP conceals nothing: tunnelled UDP is encapsulated in the
 * WebSocket/TLS carrier, so the network sees identical bytes under every
 * policy. 'none' therefore only breaks applications, which is why it is no
 * longer the default.
 *
 * Refusing QUIC is a weaker call, and worth stating honestly rather than as a
 * rule. It does NOT avoid nesting — the browser then runs TCP inside our TCP
 * tunnel, so it is reliable-over-reliable either way. What actually differs:
 * against tunnelling QUIC, each datagram is framed individually through
 * xudp/mux, QUIC's own crypto stacks on top of the tunnel's TLS, and one
 * stalled flow can head-of-line-block others sharing the mux stream; for it,
 * QUIC's loss recovery beats TCP's, and a blackholed attempt costs the browser
 * a timeout before it falls back rather than failing fast.
 *
 * So 'noquic' is the default because it matches common practice and is the
 * safer starting point, not because the tradeoff is settled. Mint an invite
 * with ?udp=1 to compare the two on a real device.
 */
function buildXrayConfig({ uuid, host, port = 443, wsPath = '/', udpPolicy = 'noquic', ca = null }) {
  const pem = ca === null ? INTERCEPT_CA_PEM : ca;
  const udp = udpPolicy === 'noquic' || udpPolicy === 'all';

  // Xray matches first-wins, so the specific udp/443 rule has to precede the
  // general udp rule. It is emitted only for 'noquic': under 'none' every UDP
  // is blocked by the general rule anyway, and under 'all' every UDP is
  // tunnelled, so in both cases it would be dead weight.
  const rules = [{ network: 'tcp,udp', port: '53', outboundTag: 'vless' }];
  if (udpPolicy === 'noquic') {
    rules.push({ network: 'udp', port: '443', outboundTag: 'block' });
  }
  rules.push({ network: 'udp', outboundTag: udp ? 'vless' : 'block' });

  const tlsSettings = { serverName: host };
  if (pem && pem.length > 0) {
    tlsSettings.certificates = [{ usage: 'verify', certificate: pem.slice() }];
  }

  return {
    routing: { rules },
    inbounds: [
      {
        tag: 'socks-in',
        listen: '127.0.0.1',
        port: 10808,
        protocol: 'socks',
        settings: { auth: 'noauth', udp: true },
        sniffing: { enabled: true, destOverride: ['http', 'tls'] }
      }
    ],
    outbounds: [
      {
        tag: 'vless',
        protocol: 'vless',
        settings: {
          vnext: [{ address: host, port, users: [{ id: uuid, encryption: 'none' }] }]
        },
        streamSettings: {
          network: 'ws',
          security: 'tls',
          tlsSettings,
          wsSettings: { path: wsPath, host },
          sockopt: { domainStrategy: 'UseIPv4' }
        },
        // Multiplexing is on: the CPU cost measured in the README is a Workers
        // free-plan constraint, not one that applies to the Node server.
        mux: {
          enabled: true,
          concurrency: 8,
          xudpConcurrency: 1024,
          xudpProxyUDP443: udpPolicy === 'all' ? 'allow' : 'reject'
        }
      },
      { tag: 'block', protocol: 'blackhole' }
    ]
  };
}

module.exports = { buildVlessLink, buildXrayConfig };
