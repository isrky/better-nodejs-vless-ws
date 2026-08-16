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
 * `udp` selects between two routing policies:
 *   false (default) — everything but DNS is blackholed locally and
 *     xudpProxyUDP443 is "reject", which pushes browsers straight off QUIC and
 *     onto TCP/TLS. That is what survives a middlebox, and blocked UDP is the
 *     common case on these networks.
 *   true — all UDP goes through the tunnel with xudpProxyUDP443 "allow".
 *     Only useful against a server that carries arbitrary UDP.
 */
function buildXrayConfig({ uuid, host, port = 443, wsPath = '/', udp = false, ca = null }) {
  const pem = ca === null ? INTERCEPT_CA_PEM : ca;

  const tlsSettings = { serverName: host };
  if (pem && pem.length > 0) {
    tlsSettings.certificates = [{ usage: 'verify', certificate: pem.slice() }];
  }

  return {
    routing: {
      rules: [
        { network: 'tcp,udp', port: '53', outboundTag: 'vless' },
        { network: 'udp', outboundTag: udp ? 'vless' : 'block' }
      ]
    },
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
          xudpProxyUDP443: udp ? 'allow' : 'reject'
        }
      },
      { tag: 'block', protocol: 'blackhole' }
    ]
  };
}

module.exports = { buildVlessLink, buildXrayConfig };
