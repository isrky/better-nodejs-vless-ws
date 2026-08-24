#!/usr/bin/env node
// Render the client configs in local/ from templates/ plus the credential store.
//
//   node tools/render-configs.mjs            render
//   node tools/render-configs.mjs --check    report drift, write nothing
//   node tools/render-configs.mjs --store P  read credentials from P
//
// Credentials live in exactly one file, local/credentials.json, managed by
// `npm run creds`. Everything under local/*.json is derived, so losing one costs
// nothing — re-render it. That is also why there are no backups here: the only
// irreplaceable input is the store, which this script never writes.
//
// This script never reads stdin and never prompts. `npm run configs` is called
// from scripts and from configs:check, so blocking on input would be a footgun.
//
// The point of the validation pass is that Xray accepts several kinds of broken
// config without complaint — an unreplaced CA placeholder is ignored rather than
// rejected, and a half-edited UDP profile is perfectly valid and simply behaves
// wrongly. `xray -test` will not save you from either. This will.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { X509Certificate } from 'node:crypto';

import {
  DEFAULT_STORE_PATH, readStore, requireRenderInputs, toRenderEnv, parseLegacyEnv,
  publicHostWarnings
} from './credstore.mjs';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The outputs. Host and UDP policy correlate today — the Worker and Deno carry
// no UDP, Fly and the VPS do — but they are independent knobs; swapping either
// column is a one-line change.
export const PROFILES = [
  { out: 'local/conf.json', template: 'linux-tproxy.json', hostVar: 'WORKER_HOST', udp: false },
  { out: 'local/conf-udp.json', template: 'linux-tproxy.json', hostVar: 'FLY_HOST', udp: true },
  { out: 'local/conf-deno.json', template: 'linux-tproxy.json', hostVar: 'DENO_HOST', udp: false },
  { out: 'local/conf-vps.json', template: 'linux-tproxy.json', hostVar: 'VPS_HOST', udp: true },
  { out: 'local/conf-android.json', template: 'android-socks.json', hostVar: 'WORKER_HOST', udp: false },
  { out: 'local/conf-android-udp.json', template: 'android-socks.json', hostVar: 'FLY_HOST', udp: true },
  { out: 'local/conf-android-deno.json', template: 'android-socks.json', hostVar: 'DENO_HOST', udp: false },
  { out: 'local/conf-android-vps.json', template: 'android-socks.json', hostVar: 'VPS_HOST', udp: true }
];

const NAME_RE = /\$\{([A-Z0-9_]+)\}/g;

const USAGE = `render the client configs in local/ from templates/ + the credential store

  node tools/render-configs.mjs             render
  node tools/render-configs.mjs --check     report drift, write nothing (exit 2 if any)
  node tools/render-configs.mjs --store P   read credentials from P
  node tools/render-configs.mjs --env P     read a retired dotenv file (deprecated)

Credentials are managed with: npm run creds`;

class RenderError extends Error {}

function fail(msg) {
  throw new RenderError(msg);
}

/** Exactly one leading slash; the store itself is never rewritten. */
export function normaliseWsPath(raw) {
  const v = String(raw).trim();
  if (v === '') fail('WSPATH is empty');
  if (/[\s#]/.test(v)) fail('WSPATH contains whitespace or "#"');
  return '/' + v.replace(/^\/+/, '');
}

// ==========================================
// Substitution
// ==========================================

/**
 * Replace ${NAME} throughout a parsed template.
 *
 * Operating on the parsed JSON rather than the raw text means every value goes
 * back out through JSON.stringify, so the result is valid and correctly escaped
 * however strange the input — a quote or backslash in a path cannot produce a
 * broken file. It is also the only way to splice the multi-line CA into an array
 * while keeping the template itself valid JSON.
 */
export function substitute(node, bindings, path = '$', errors = []) {
  if (Array.isArray(node)) {
    const out = [];
    node.forEach((item, i) => {
      const whole = typeof item === 'string' && item.match(/^\$\{([A-Z0-9_]+)\}$/);
      if (whole && Array.isArray(bindings[whole[1]])) {
        out.push(...bindings[whole[1]]);
        return;
      }
      out.push(substitute(item, bindings, `${path}[${i}]`, errors));
    });
    return out;
  }

  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = substitute(v, bindings, `${path}.${k}`, errors);
    return out;
  }

  if (typeof node === 'string') {
    return node.replace(NAME_RE, (whole, name) => {
      const value = bindings[name];
      if (value === undefined) {
        errors.push(`${path}: unknown placeholder \${${name}} (known: ${Object.keys(bindings).join(', ')})`);
        return whole;
      }
      if (Array.isArray(value)) {
        errors.push(`${path}: \${${name}} is a list and may only stand alone as an array element`);
        return whole;
      }
      return value;
    });
  }

  return node;
}

/**
 * An empty CA means "no pinned certificate", which no in-string placeholder can
 * express — a placeholder cannot delete a key. Mirrors buildXrayConfig's
 * `if (pem && pem.length > 0)` in src/node/clientconf.js.
 */
function dropBlankQuicRule(config) {
  // Same shape as dropEmptyCertificates: a placeholder that resolves to empty
  // removes its block rather than rendering a rule with no outbound. Only the
  // 'noquic' policy needs a udp/443 rule — under 'none' the general udp rule
  // already blocks it, and under 'all' nothing is blocked.
  const rules = config.routing?.rules;
  if (!Array.isArray(rules)) return;
  const i = rules.findIndex((r) => r.network === 'udp' && r.port === '443' && !r.outboundTag);
  if (i !== -1) rules.splice(i, 1);
}

function dropEmptyCertificates(config) {
  const tls = config.outbounds?.[0]?.streamSettings?.tlsSettings;
  if (tls && Array.isArray(tls.certificates) && tls.certificates[0]?.certificate?.length === 0) {
    delete tls.certificates;
  }
}

// ==========================================
// The certificate
// ==========================================

export function loadCaLines(env, root = ROOT) {
  const override = env.INTERCEPT_CA_FILE;

  if (override === undefined) {
    return require(join(root, 'src/node/interceptca.js')).INTERCEPT_CA_PEM;
  }
  if (override.trim() === '') return [];   // deliberately no pinned CA

  const path = resolve(root, override);
  if (/\.cer$/i.test(path) || /\.der$/i.test(path)) {
    fail(`INTERCEPT_CA_FILE: ${override} looks like DER. Convert it first:\n` +
         `  openssl x509 -inform der -in ${override} -out ca.pem`);
  }
  if (!existsSync(path)) fail(`INTERCEPT_CA_FILE: ${override} does not exist`);

  return readFileSync(path, 'utf8').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
}

function validateCa(lines) {
  if (lines.length === 0) return null;

  if (lines[0] !== '-----BEGIN CERTIFICATE-----' ||
      lines[lines.length - 1] !== '-----END CERTIFICATE-----') {
    fail('the CA is missing its BEGIN/END markers');
  }

  let cert;
  try {
    // This is what catches an unreplaced placeholder. Xray would accept it
    // silently: it ignores PEM it cannot parse rather than rejecting the config.
    cert = new X509Certificate(lines.join('\n') + '\n');
  } catch (e) {
    fail(`the CA is not parseable PEM (${e.code || e.message}) — is it still a placeholder?`);
  }

  if (new Date(cert.validTo) < new Date()) {
    console.warn(`warning: the pinned CA expired on ${cert.validTo}`);
  }
  return cert;
}

// ==========================================
// Validation
// ==========================================

function walkStrings(node, visit, path = '$') {
  if (Array.isArray(node)) return node.forEach((v, i) => walkStrings(v, visit, `${path}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node).forEach(([k, v]) => walkStrings(v, visit, `${path}.${k}`));
  }
  if (typeof node === 'string') visit(node, path);
}

function hasKey(node, key) {
  if (Array.isArray(node)) return node.some((v) => hasKey(v, key));
  if (node && typeof node === 'object') {
    return Object.keys(node).includes(key) || Object.values(node).some((v) => hasKey(v, key));
  }
  return false;
}

/** Everything here is a failure Xray itself would accept. */
export function validateConfig(config, profile) {
  const where = profile.out;

  walkStrings(config, (value, path) => {
    if (value.includes('${')) fail(`${where} ${path}: unreplaced placeholder ${value}`);
  });

  const out = config.outbounds.filter((o) => o.protocol === 'vless');
  if (out.length !== 1) fail(`${where}: expected exactly one vless outbound, found ${out.length}`);

  const vless = out[0];
  const ss = vless.streamSettings;
  const address = vless.settings.vnext[0].address;

  // A mismatch here is a Cloudflare 403 with no WebSocket upgrade, which reads
  // as a network fault rather than a config error.
  if (ss.tlsSettings.serverName !== address || ss.wsSettings.host !== address) {
    fail(`${where}: address, tlsSettings.serverName and wsSettings.host must all match`);
  }

  if (!ss.wsSettings.path.startsWith('/')) fail(`${where}: wsSettings.path must start with /`);

  // The two halves of the UDP axis must agree. A half-edit is a valid config
  // that simply behaves wrongly, and nothing else would catch it.
  // The catch-all udp rule, not the specific udp/443 one that may precede it.
  const udpRule = config.routing.rules.find((r) => r.network === 'udp' && r.port === undefined);
  const tunnelled = udpRule && udpRule.outboundTag === 'vless';
  const allowed = vless.mux.xudpProxyUDP443 === 'allow';
  if (tunnelled !== allowed) {
    fail(`${where}: udp routing (${udpRule && udpRule.outboundTag}) and ` +
         `xudpProxyUDP443 (${vless.mux.xudpProxyUDP443}) disagree`);
  }

  for (const forbidden of ['alpn', 'allowInsecure', 'pinnedPeerCertSha256']) {
    if (hasKey(config, forbidden)) fail(`${where}: must not contain "${forbidden}"`);
  }

  const tags = new Set(config.outbounds.map((o) => o.tag));
  for (const rule of config.routing.rules) {
    if (rule.outboundTag && !tags.has(rule.outboundTag)) {
      fail(`${where}: routing rule targets unknown outbound "${rule.outboundTag}"`);
    }
  }
}

// ==========================================
// Rendering
// ==========================================

export function renderProfile({ template, host, udpPolicy, uuid, wsPath, caLines, root = ROOT }) {
  const source = JSON.parse(readFileSync(resolve(root, 'templates', template), 'utf8'));

  const bindings = {
    UUID: uuid,
    WSPATH: wsPath,
    HOST: host,
    UDP_OUTBOUND: udpPolicy === 'none' ? 'block' : 'vless',
    QUIC_OUTBOUND: udpPolicy === 'noquic' ? 'block' : '',
    XUDP_443: udpPolicy === 'all' ? 'allow' : 'reject',
    CA_PEM_LINES: caLines
  };

  const errors = [];
  const config = substitute(source, bindings, '$', errors);
  if (errors.length) fail(`templates/${template}:\n  ` + errors.join('\n  '));

  dropBlankQuicRule(config);
  dropEmptyCertificates(config);
  return config;
}

/**
 * Render every profile from a store.
 *
 * Takes the store rather than a path so the caller decides where credentials
 * came from — and so this function cannot be the thing that reads a file the
 * operator has not been told about.
 */
function renderAll(store) {
  const { uuid, wsPath, hosts } = requireRenderInputs(store);

  // toRenderEnv is the only thing that builds this object, and it copies with
  // `in` semantics: that is what keeps INTERCEPT_CA_FILE's absent/empty/path
  // tri-state intact. Coercing a missing key to '' here would silently strip
  // the pinned CA from all four configs.
  const env = toRenderEnv(store);
  const caLines = loadCaLines(env);
  const cert = validateCa(caLines);

  // A profile whose host is unset is skipped, not failed: DENO_HOST is
  // optional, so the -deno configs only appear once a Deno Deploy target
  // exists. Announced rather than dropped silently. (Required hosts are already
  // enforced by requireRenderInputs above, so this only ever skips Deno.)
  const active = PROFILES.filter((profile) => {
    if (hosts[profile.hostVar]) return true;
    console.error(`notice: skipping ${profile.out} — ${profile.hostVar} is not set`);
    return false;
  });

  // Render and validate everything before writing anything: a failure on the
  // last profile must not leave the earlier ones replaced.
  const rendered = active.map((profile) => {
    const config = renderProfile({
      template: profile.template,
      host: hosts[profile.hostVar],
      udpPolicy: profile.udp ? 'all' : 'none',
      uuid,
      wsPath,
      caLines
    });
    validateConfig(config, profile);
    return { profile, text: JSON.stringify(config, null, 2) + '\n' };
  });

  return { rendered, uuid, wsPath, hosts, cert, caSource: caSourceOf(env) };
}

/** Which of the three CA states is in play — the summary must distinguish them. */
function caSourceOf(env) {
  if (!('INTERCEPT_CA_FILE' in env)) return 'bundled';
  return env.INTERCEPT_CA_FILE === '' ? 'none' : env.INTERCEPT_CA_FILE;
}

/**
 * Load credentials for a render.
 *
 * `--env` is kept as a deprecated alias because a rotation rollback restores an
 * old dotenv file that the operator may need to re-render from. It reads in
 * memory and never writes.
 */
function loadStore({ storePath, envPath }) {
  if (envPath) {
    if (!existsSync(envPath)) fail(`${envPath} not found`);
    console.error('notice: --env is deprecated; import it with `npm run creds -- --import <path>`');
    return { version: 1, credentials: parseLegacyEnv(readFileSync(envPath, 'utf8'), envPath) };
  }

  if (!existsSync(storePath) && existsSync(resolve(ROOT, 'local/.env'))) {
    // Transitional: the store has not been created yet but the retired file is
    // still there. Read it in memory; never migrate-with-write from a path that
    // scripts call.
    console.error('notice: reading legacy local/.env; run `npm run creds` to migrate');
    return {
      version: 1,
      credentials: parseLegacyEnv(readFileSync(resolve(ROOT, 'local/.env'), 'utf8'), 'local/.env')
    };
  }

  return readStore(storePath);
}

// ==========================================
// CLI
// ==========================================

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const check = argv.includes('--check');
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : resolve(process.cwd(), argv[i + 1] || '');
  };

  const store = loadStore({ storePath: flag('--store') || DEFAULT_STORE_PATH, envPath: flag('--env') });
  const { rendered, uuid, wsPath, hosts, cert, caSource } = renderAll(store);

  for (const warning of publicHostWarnings(store)) console.error(`warning: ${warning}`);

  let drifted = 0;
  const rows = rendered.map(({ profile, text }) => {
    const path = resolve(ROOT, profile.out);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const same = current === text;
    if (!same) drifted += 1;
    return { profile, text, path, same };
  });

  if (!check) {
    mkdirSync(resolve(ROOT, 'local'), { recursive: true, mode: 0o700 });
    for (const row of rows) {
      if (row.same) continue;
      // Write then rename: atomic on POSIX, so a config is never half-written.
      const tmp = row.path + '.tmp';
      try {
        writeFileSync(tmp, row.text, { mode: 0o600 });
        renameSync(tmp, row.path);
      } catch (e) {
        if (existsSync(tmp)) unlinkSync(tmp);
        throw e;
      }
    }
  }

  for (const { profile, same } of rows) {
    const state = same ? 'unchanged' : (check ? 'DRIFT' : 'written');
    console.log(
      profile.out.padEnd(28) +
      profile.template.replace('.json', '').padEnd(15) +
      `host=${hosts[profile.hostVar]}`.padEnd(28) +
      `udp=${profile.udp ? 'on ' : 'off'}  ${state}`
    );
  }

  // Never print the ws path or the full UUID: terminal output gets pasted around.
  // The CA line is three-way on purpose — "none" and "bundled" are different
  // outcomes and collapsing them hides a silent loss of the pinned certificate.
  const subject = cert ? `CN=${cert.subject.split('CN=')[1] || '?'} (expires ${cert.validTo})` : '';
  const ca = caSource === 'none'
    ? 'none (INTERCEPT_CA_FILE is empty)'
    : `${caSource} ${subject}`;
  console.log(`\nCA: ${ca}   UUID: ${uuid.slice(0, 8)}…   WSPATH: ${wsPath.length} chars`);

  if (check && drifted > 0) {
    console.error(`\n${drifted} file(s) differ from the credential store — run: npm run configs`);
    return 2;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof RenderError ? `error: ${e.message}` : e);
    process.exit(1);
  }
}
