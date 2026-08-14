#!/usr/bin/env node
// QR import pipeline for the Xray Android client.
//
//   node tools/qr.mjs [link] [config.json]   build a vless:// link + QR
//   node tools/qr.mjs serve  [config.json]   serve the full JSON over the LAN + QR
//
// Two modes because a vless:// share link cannot carry the pinned interception
// CA in the config's `certificates` block:
//   - link  -> works on ordinary networks (Cloudflare's cert is publicly valid)
//   - serve -> hands the phone the *whole* config (CA included) for networks
//              that MITM TLS, without the credentials ever leaving the LAN.
//
// Everything is offline; the link/JSON hold the UUID, so nothing is sent to a
// third-party QR service. PNG output lands in the gitignored local/ dir.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = resolve(ROOT, 'local/conf-android.json');

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

async function loadConfig(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    die(`cannot read config: ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    die(`config is not valid JSON (${path}): ${e.message}`);
  }
}

/** Pull the first vless outbound and flatten the fields a share link needs. */
function extractVless(config) {
  const out = (config.outbounds || []).find((o) => o.protocol === 'vless');
  if (!out) die('no vless outbound found in config');

  const vnext = out.settings?.vnext?.[0];
  const user = vnext?.users?.[0];
  if (!vnext || !user) die('vless outbound is missing settings.vnext[0].users[0]');

  const ss = out.streamSettings || {};
  const tls = ss.tlsSettings || {};
  const ws = ss.wsSettings || {};

  return {
    id: user.id,
    address: vnext.address,
    port: vnext.port ?? 443,
    encryption: user.encryption || 'none',
    network: ss.network || 'tcp',
    security: ss.security || 'none',
    sni: tls.serverName || vnext.address,
    fingerprint: tls.fingerprint || '',
    alpn: Array.isArray(tls.alpn) ? tls.alpn.join(',') : '',
    host: ws.host || tls.serverName || vnext.address,
    path: ws.path || '/',
    pinnedCert: Boolean(tls.certificates?.length),
    label: out.tag && out.tag !== 'vless' ? out.tag : tls.serverName || vnext.address,
  };
}

/** Build a v2rayNG/sing-box-compatible vless:// share link. */
function buildLink(v) {
  const params = new URLSearchParams();
  params.set('encryption', v.encryption);
  params.set('security', v.security);
  if (v.security === 'tls') params.set('sni', v.sni);
  if (v.fingerprint) params.set('fp', v.fingerprint);
  if (v.alpn) params.set('alpn', v.alpn);
  params.set('type', v.network);
  if (v.network === 'ws') {
    params.set('host', v.host);
    params.set('path', v.path);
  }
  const auth = `${v.id}@${v.address}:${v.port}`;
  return `vless://${auth}?${params.toString()}#${encodeURIComponent(v.label)}`;
}

function firstLanIPv4() {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

async function printQR(text) {
  // Small terminal QR; phone cameras read it straight off the screen.
  console.log(await QRCode.toString(text, { type: 'terminal', small: true }));
}

async function cmdLink(configPath) {
  const config = await loadConfig(configPath);
  const v = extractVless(config);
  const link = buildLink(v);
  const pngPath = resolve(ROOT, 'local/qr-link.png');

  await QRCode.toFile(pngPath, link, { width: 512, margin: 2 });

  console.log(link);
  console.log();
  await printQR(link);
  console.log(`PNG written: ${pngPath}`);
  if (v.pinnedCert) {
    console.log(
      '\nNote: this link drops the pinned CA and mux. Use it only on networks\n' +
        'that do NOT intercept TLS. For the MEB network run:  node tools/qr.mjs serve',
    );
  }
}

async function cmdServe(configPath) {
  // Serve the raw config file (CA and all) so the phone can import it as a
  // custom config. Read the bytes now so we can report failures up front.
  const body = await readFile(configPath).catch(() => die(`cannot read config: ${configPath}`));
  const ip = firstLanIPv4();
  if (!ip) die('no LAN IPv4 interface found — connect to Wi-Fi and retry');

  const token = randomBytes(9).toString('base64url'); // high-entropy one-off path
  const urlPath = `/${token}/conf-android.json`;

  const server = createServer((req, res) => {
    if (req.url !== urlPath) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="conf-android.json"',
    });
    res.end(body);
  });

  server.listen(0, '0.0.0.0', async () => {
    const { port } = server.address();
    const url = `http://${ip}:${port}${urlPath}`;
    console.log(`Serving ${configPath}\n(LAN only, random path — Ctrl-C to stop)\n`);
    console.log(url);
    console.log();
    await printQR(url);
    console.log('Scan from the phone on the same Wi-Fi, download, then import as a Custom config.');
  });

  process.on('SIGINT', () => {
    console.log('\nstopped.');
    server.close(() => process.exit(0));
  });
}

const [, , rawCmd, rawPath] = process.argv;
const cmd = rawCmd && !rawCmd.endsWith('.json') ? rawCmd : 'link';
const configPath = (rawCmd?.endsWith('.json') ? rawCmd : rawPath) || DEFAULT_CONFIG;

if (cmd === 'link') await cmdLink(configPath);
else if (cmd === 'serve') await cmdServe(configPath);
else die(`unknown command: ${cmd} (use "link" or "serve")`);
