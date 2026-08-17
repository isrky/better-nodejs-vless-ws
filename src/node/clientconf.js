'use strict';

// The Xray config handed to a provisioned user.
//
// One artefact, not two. A vless:// share link used to sit alongside it, but the
// URI format has no slot for a certificate, so it could never carry the
// interception CA — on the networks this exists for it was the prominent option
// that could not work. The JSON is not a fallback for those networks either:
// `usage: "verify"` without `disableSystemRoot` means Xray APPENDS the pinned CA
// to the system roots rather than replacing them, so the same file verifies a
// real certificate on an ordinary network and a re-signed one at school.
//
// Pure and dependency-free: no I/O, no env reads, no clock.

const { INTERCEPT_CA_PEM } = require('./interceptca.js');

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

module.exports = { buildXrayConfig };
