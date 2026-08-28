#!/usr/bin/env node
// Interactive credential manager for local/credentials.json.
//
//   npm run creds                 the dashboard
//   npm run creds:status          redacted report, never prompts
//   npm run creds:push            reveal the secrets, to paste into the dashboards
//
// The interactive path is an Ink dashboard (tools/tui/) and therefore uses
// raw mode; Ink restores the terminal on every exit path, including thrown
// errors, and a terminal that cannot switch to raw mode gets the status
// report instead of a crash. Everything non-interactive — every flag, and any
// invocation without a TTY — runs in this file with plain stdout and never
// loads Ink, so scripts and pipes see the same tool they always did.
//
// Edits are written through immediately rather than saved on exit. The failure
// this defends against is credential loss, and a freshly generated UUID that
// exists only in memory is precisely what you cannot recover.

import { createInterface } from 'node:readline/promises';
import {
  existsSync, readFileSync, renameSync, writeFileSync, unlinkSync,
  statSync, chmodSync
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  FIELDS, DEFAULT_STORE_PATH, StoreError,
  emptyStore, readStore, writeStore, storeMode, withField,
  redact, validateStore,
  parseLegacyEnv, planImport, pushPlan, publicHostWarnings, platformNames,
  writeEnvFile, PLATFORM_GROUPS, PLATFORM_META
} from './credstore.mjs';

import {
  generateKeys, readKeyring, writeKeyring, encryptStore, decryptSecretsFile,
  writeSecretsFile, readSecretsFile, platformKeys,
  DEFAULT_KEYRING_PATH, SECRETS_FILE_PATH
} from './credsecrets.mjs';

import { writeClipboard } from './clipboard.mjs';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_ENV = resolve(ROOT, 'local/.env');

const USAGE = `manage the credentials in local/credentials.json

  npm run creds                    interactive dashboard (S = quick setup)
  npm run creds:status             redacted report (never prompts)
  npm run creds:push               show the secrets, grouped by dashboard
  npm run creds:env                export Deno's two group keys to local/deno.env
  npm run creds:docker             export Docker's two group keys to local/docker.env
  npm run creds:pin                print FRONT_CERT_PIN for the VPS .env (probes the edge)
  npm run creds:encrypt            re-encrypt the store into src/node/secrets.enc.json
  npm run creds:decrypt            rebuild the local store from the committed file + keyring
  npm run creds:keys               reveal the group keys to set once per platform
  node tools/credentials.mjs --init-keys
                                   generate the local keyring (local/secrets.keys.json)
  node tools/credentials.mjs --push --yes
                                   skip the confirmation (prints secrets)
  node tools/credentials.mjs --import PATH
                                   import a retired local/.env

Rendering the client configs is a separate step: npm run configs`;

class Cancelled extends Error {}

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (colour ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (colour ? `\x1b[1m${s}\x1b[0m` : s);
const red = (s) => (colour ? `\x1b[31m${s}\x1b[0m` : s);

// ==========================================
// Reports — all pure, all redacted
// ==========================================

function problemsByKey(store) {
  const map = new Map();
  for (const p of validateStore(store)) map.set(p.key, p);
  return map;
}

export function renderMenu(store, storePath = DEFAULT_STORE_PATH) {
  const problems = problemsByKey(store);
  const lines = [];

  lines.push('');
  lines.push(`${bold('credentials')} ${dim(storePath.replace(ROOT + '/', ''))}` +
             `   ${dim(`v${store.version}  ${storeMode(storePath)}`)}`);

  let n = 0;
  for (const group of ['render', 'server']) {
    lines.push('');
    lines.push(dim(group === 'render'
      ? '  used to render the client configs'
      : '  server-side only — never written into a config'));

    for (const f of FIELDS) {
      if (f.group !== group) continue;
      n += 1;
      const problem = problems.get(f.key);
      const state = problem ? red(problem.reason) : (store.credentials[f.key] === undefined ? '' : 'ok');
      const target = f.pushTo.length ? dim('-> ' + f.pushTo.join(', ')) : '';
      lines.push(
        `  ${String(n).padStart(2)}  ${f.key.padEnd(26)}` +
        `${redact(f.key, store.credentials[f.key]).padEnd(24)}${state.padEnd(12)}${target}`
      );
    }
  }

  lines.push('');
  lines.push('   r  render the configs      p  reveal secrets to paste');
  lines.push('   e  export group-key envs   f  print front cert pin');
  lines.push('   u  undo last change        q  quit');
  lines.push('');
  return lines.join('\n');
}

export function statusReport(store, storePath = DEFAULT_STORE_PATH) {
  const problems = validateStore(store);
  const lines = [renderMenu(store, storePath).replace(/\n\s{3}[rupqef] .*/g, '')];

  for (const warning of publicHostWarnings(store)) lines.push(`warning: ${warning}`);
  if (problems.length) {
    lines.push(`${problems.length} problem(s) — run: npm run creds`);
  }
  return lines.join('\n');
}

/**
 * What is about to be revealed — key names and destinations only.
 *
 * Safe to print anywhere, and it doubles as the checklist: there is no separate
 * no-values mode to keep in step with this one.
 */
export function formatRevealPrompt(plan, names) {
  const count = new Set([...plan.fly, ...plan.wrangler]).size;
  const out = ['', `About to print ${count} secret value(s) to this terminal.`, ''];

  out.push(`  Fly · ${names.fly}${' '.repeat(Math.max(1, 22 - names.fly.length))}` +
           `${plan.fly.join(' ') || '(nothing set)'}`);
  out.push(`  Worker · ${names.worker}${' '.repeat(Math.max(1, 19 - names.worker.length))}` +
           `${plan.wrangler.join(' ') || '(nothing set)'}`);

  out.push('');
  out.push(dim('  They will stay in your scrollback.'));
  out.push('');
  return out.join('\n');
}

/**
 * The admin dashboard URL, ready to open, or null when there is nothing to link.
 *
 * With ADMIN_TOKEN unset the route is hidden behind the decoy, so a URL would be
 * a lie; without FLY_HOST there is no host to build one from. https because
 * fly.toml sets force_https.
 *
 * The token is percent-encoded even though a generated one is hex and needs
 * none: it costs nothing and keeps this correct for a hand-entered token.
 */
export function adminUrl(store) {
  const { ADMIN_TOKEN, FLY_HOST } = store.credentials;
  if (!ADMIN_TOKEN || !FLY_HOST) return null;
  return `https://${FLY_HOST}/admin-stats?token=${encodeURIComponent(ADMIN_TOKEN)}`;
}

/**
 * The secrets themselves, grouped by where they are pasted.
 *
 * This is the ONLY function in the tool that prints a credential — keeping that
 * true is what makes the leak surface auditable in one place.
 */
export function formatReveal(plan, store, names) {
  const out = [''];

  const section = (keys) => {
    for (const key of keys) {
      out.push(`  ${bold(key)}`);
      out.push(`    ${store.credentials[key]}`);
    }
  };

  if (plan.fly.length) {
    out.push(bold(`Fly — https://fly.io/apps/${names.fly}/secrets`));
    out.push(dim('  Secrets → New secret. Setting any of these restarts the machine, which'));
    out.push(dim('  briefly drops every tunnel and resets the stats counters — do them together.'));
    out.push('');
    section(plan.fly);

    const url = adminUrl(store);
    if (url) {
      // Handed over ready to open. A wrong token is not an error page but the
      // decoy, so an encoding slip here looks like an outage rather than a
      // typo — worth removing the step entirely.
      out.push(`  ${bold('Admin dashboard')} ${dim('(token already encoded)')}`);
      out.push(`    ${url}`);
    }
    out.push('');
  }

  if (plan.wrangler.length) {
    out.push(bold(`Cloudflare — Workers & Pages → ${names.worker} → Settings → Variables and Secrets`));
    out.push(dim('  Add each as a SECRET, not a plaintext Variable. A plaintext variable is'));
    out.push(dim('  overwritten from wrangler.toml on the next `wrangler deploy`; a secret survives.'));
    out.push('');
    section(plan.wrangler);
    out.push('');
  }

  if (plan.renderOnly.length) {
    out.push(`Not pushed anywhere: ${plan.renderOnly.join(' ')}   ${dim('(render inputs only)')}`);
    out.push('');
  }

  out.push('Then:  npm run configs   npm run qr   npm run configs:check');
  out.push(dim('Do this from a network you do NOT reach through the tunnel — every device'));
  out.push(dim('on the old credential drops the moment these land, including this one.'));
  for (const w of plan.warnings) out.push(red(`warning: ${w}`));
  out.push('');
  return out.join('\n');
}

// ==========================================
// Prompting
// ==========================================

function makeAsk(rl) {
  return async function ask(query) {
    const ac = new AbortController();
    const cancel = () => ac.abort();
    rl.once('SIGINT', cancel);
    rl.once('close', cancel);
    try {
      return (await rl.question(query, { signal: ac.signal })).trim();
    } catch (e) {
      // rl.question does not resolve on EOF, so Ctrl-D arrives here too.
      if (e.name === 'AbortError') throw new Cancelled();
      throw e;
    } finally {
      rl.off('SIGINT', cancel);
      rl.off('close', cancel);
    }
  };
}

/**
 * Show what is about to be printed, get a yes, then print it.
 *
 * The confirmation is not ceremony: this is the one command that puts
 * credentials on screen and into scrollback, so a mistyped keystroke should not
 * be enough to paint them across a shared display.
 */
export async function revealWithConfirmation(store, ask, out) {
  const plan = pushPlan(store);
  const names = platformNames();

  if (!plan.fly.length && !plan.wrangler.length) {
    out('  nothing to push — no pushable value is set');
    return false;
  }

  out(formatRevealPrompt(plan, names));
  const answer = (await ask('  Continue? [y/N] ')).toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    out('  (nothing printed)');
    return false;
  }

  out(formatReveal(plan, store, names));
  return true;
}

/**
 * Write one platform's group keys as a 0600 dotenv file next to the store.
 *
 * The values stay in the gitignored local directory and only the path/key names
 * are announced. The encrypted payload now carries the credentials themselves,
 * so exports deliberately contain no UUID/WSPATH/server values or deployment
 * config — only the two keys that target needs to decrypt its groups.
 */
const requiredGroups = (platforms) =>
  [...new Set(platforms.flatMap((platform) => PLATFORM_GROUPS[platform] || []))];

const missingGroups = (keys, platforms) =>
  requiredGroups(platforms).filter((group) => !keys?.[group]);

function requireKeyring(keyringPath, platforms, out) {
  const keys = readKeyring(keyringPath);
  if (!keys) {
    out('  no keyring — run: node tools/credentials.mjs --init-keys');
    return null;
  }
  const missing = missingGroups(keys, platforms);
  if (missing.length) {
    out(`  keyring is missing ${missing.join(', ')} — re-run --init-keys --force to replace it`);
    return null;
  }
  return keys;
}

/** The paste-ready dotenv body for a platform's group keys. Carries secrets. */
function platformEnvText(platform, keys) {
  return platformKeys(platform, keys).map(({ envName, value }) => `${envName}=${value}`).join('\n') + '\n';
}

function writePlatformKeyEnv(platform, filename, storePath, keys, out, guidance) {
  const entries = platformKeys(platform, keys);
  const path = resolve(dirname(storePath), filename);
  writeEnvFile(path, platformEnvText(platform, keys));
  out(`  wrote ${path.replace(ROOT + '/', '')} (${entries.map(({ envName }) => envName).join(', ')})`);
  out(dim(guidance));
  return path;
}

export function exportDenoEnv(storePath, out, keyringPath = DEFAULT_KEYRING_PATH) {
  const keys = requireKeyring(keyringPath, ['deno'], out);
  if (!keys) return null;
  return writePlatformKeyEnv(
    'deno', 'deno.env', storePath, keys, out,
    '  upload it in the Deno Deploy dashboard, or paste its contents into the env import'
  );
}

export function exportDockerEnv(storePath, out, keyringPath = DEFAULT_KEYRING_PATH) {
  const keys = requireKeyring(keyringPath, ['docker'], out);
  if (!keys) return null;
  return writePlatformKeyEnv(
    'docker', 'docker.env', storePath, keys, out,
    "  paste its contents into the Dockge stack's .env editor; add deployment config separately"
  );
}

// Per-target paste guidance. Filenames live in PLATFORM_META (credstore) so the
// export, the reveal, and the envs tab all name the files the same way.
const PLATFORM_GUIDANCE = {
  fly: '  set with: fly secrets set SECRETS_KEY_COMMON=… SECRETS_KEY_SERVER=… (or fly secrets import < local/fly.env)',
  docker: "  paste its contents into the Dockge stack's .env editor; add deployment config separately",
  wrangler: '  add each as a Worker secret: wrangler secret put SECRETS_KEY_COMMON / SECRETS_KEY_EDGE (or the dashboard)',
  deno: '  upload it in the Deno Deploy dashboard, or paste its contents into the env import'
};

/** Export one paste-ready env file per target after validating the complete keyring once. */
export function exportKeyEnvs(storePath, out, keyringPath = DEFAULT_KEYRING_PATH) {
  const platforms = Object.keys(PLATFORM_GROUPS);
  const keys = requireKeyring(keyringPath, platforms, out);
  if (!keys) return null;
  return platforms.map((platform) =>
    writePlatformKeyEnv(platform, PLATFORM_META[platform].envFile, storePath, keys, out, PLATFORM_GUIDANCE[platform]));
}

/**
 * Per-target env-file freshness, for the dashboard's envs tab. Compares each
 * written file against what the current keyring would produce and returns an
 * enum per platform ('ok' | 'stale' | 'missing' | 'no-keyring') — never a key
 * value, so the result is safe to surface in a frame.
 */
export function envFileStatus(storePath, keyringPath = DEFAULT_KEYRING_PATH) {
  const keys = readKeyring(keyringPath);
  const status = {};
  for (const platform of Object.keys(PLATFORM_GROUPS)) {
    if (!PLATFORM_GROUPS[platform].every((g) => keys?.[g])) { status[platform] = 'no-keyring'; continue; }
    const path = resolve(dirname(storePath), PLATFORM_META[platform].envFile);
    if (!existsSync(path)) { status[platform] = 'missing'; continue; }
    status[platform] = readFileSync(path, 'utf8') === platformEnvText(platform, keys) ? 'ok' : 'stale';
  }
  return status;
}

/**
 * Copy one target's paste-ready group-key block to the clipboard. Reads the
 * keyring at call time (the values never live in the TUI state), and only ever
 * logs the filename, method, and env-var names — never a value. `write` is
 * injectable so tests don't touch a real clipboard. `storePath` is accepted for
 * signature parity with exportKeyEnvs; the keyring is always the canonical one.
 */
export function copyEnvToClipboard(storePath, platform, out, keyringPath = DEFAULT_KEYRING_PATH, write = writeClipboard) {
  const keys = requireKeyring(keyringPath, [platform], out);
  if (!keys) return null;
  const entries = platformKeys(platform, keys);
  const method = write(platformEnvText(platform, keys));
  out(`  copied ${PLATFORM_META[platform].envFile} to the clipboard via ${method} (${entries.map(({ envName }) => envName).join(', ')})`);
  return method;
}

/**
 * Probe the VPS edge for the cert it serves under the spoofed SNI and print
 * FRONT_CERT_PIN, ready to paste into the stack's .env. The server normally
 * self-probes for this, but a container that cannot NAT-hairpin to its own
 * public IP can be handed the pin instead.
 *
 * The pin is a public fingerprint, not a secret — so this prints straight to the
 * terminal with no confirmation. `probe` is injectable for tests; it defaults to
 * the runtime tls probe in src/node/certpin.js.
 *
 * @returns the pin string, or null when the inputs are missing or the probe fails.
 */
export async function printFrontPin(store, out, probe) {
  const host = store.credentials.VPS_HOST;
  const sni = store.credentials.FRONT_SNI;
  if (!host || !sni) {
    out('  set VPS_HOST and FRONT_SNI first (fronting needs both)');
    return null;
  }
  const fetch = probe || ((h, s) => require(join(ROOT, 'src/node/certpin.js')).fetchCertInfo(h, s));
  out(dim(`  probing ${host}:443 with SNI ${sni} …`));
  let info;
  try {
    info = await fetch(host, sni);
  } catch (e) {
    out(red(`  probe failed: ${e.message}`));
    return null;
  }
  out(dim(`  cert: CN=${info.subject}  issuer=${info.issuer}  expires ${info.validTo}`));
  if (/fatih|meb/i.test(info.issuer)) {
    out(red('  warning: this looks like an interception cert — pinning it only works on that network'));
  }
  out('');
  out(`FRONT_CERT_PIN=${info.pin}`);
  out('');
  out(dim('  add that line to the Dockge stack\'s .env (alongside the docker.env keys), then redeploy'));
  return info.pin;
}

// ==========================================
// Import
// ==========================================

export function describeImport(plan) {
  const lines = [];
  if (plan.add.length) lines.push(`  new:        ${plan.add.join(' ')}`);
  if (plan.same.length) lines.push(`  identical:  ${plan.same.join(' ')}`);
  for (const d of plan.differ) {
    lines.push(`  differs:    ${d.key}  (store #${d.current}  incoming #${d.incoming})`);
  }
  if (plan.unknown.length) {
    lines.push(`  unmanaged:  ${plan.unknown.join(' ')}  ${dim('(kept verbatim)')}`);
  }
  return lines.join('\n');
}

function loadStoreOrEmpty(storePath) {
  return existsSync(storePath) ? readStore(storePath) : emptyStore();
}

// ==========================================
// Encrypted secrets
// ==========================================

/**
 * Re-encrypt the store's shared secrets into the committed file, so it tracks
 * the store. A no-op (returns null) when there is no keyring yet — the store
 * still works locally; encryption is opt-in via `--init-keys`. Called after
 * every edit in the TUI and by `--encrypt`.
 */
export function syncSecretsFile(store, keyringPath = DEFAULT_KEYRING_PATH, filePath = SECRETS_FILE_PATH) {
  const keys = readKeyring(keyringPath);
  if (!keys) return null;
  writeSecretsFile(encryptStore(store, keys), filePath);
  return filePath;
}

const fileSnapshot = (path) => existsSync(path)
  ? { data: readFileSync(path), mode: statSync(path).mode & 0o777 }
  : null;

function restoreSnapshot(path, snapshot) {
  if (!snapshot) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  writeFileSync(path, snapshot.data);
  chmodSync(path, snapshot.mode);
}

/**
 * Commit a soft or full emergency rotation without ever returning key material.
 * Every output is prepared before the first write. If a later write fails, the
 * original store, backup, keyring and ciphertext are restored byte-for-byte.
 */
export function commitCredentialNuke(store, {
  kind,
  storePath = DEFAULT_STORE_PATH,
  keyringPath = DEFAULT_KEYRING_PATH,
  secretsFilePath = SECRETS_FILE_PATH,
  canonicalStorePath = DEFAULT_STORE_PATH,
  io = { writeStore, writeKeyring, writeSecretsFile }
} = {}) {
  if (kind !== 'soft' && kind !== 'full') throw new StoreError(`unknown nuke kind ${kind}`);
  if (kind === 'full' && storePath !== canonicalStorePath) {
    throw new StoreError('full nuke is disabled for a custom --store');
  }

  const keys = kind === 'full' ? generateKeys() : readKeyring(keyringPath);
  const encrypted = storePath === canonicalStorePath && keys ? encryptStore(store, keys) : null;
  const paths = [storePath, storePath + '.bak'];
  if (kind === 'full') paths.push(keyringPath);
  if (encrypted) paths.push(secretsFilePath);
  const snapshots = new Map(paths.map((path) => [path, fileSnapshot(path)]));

  try {
    io.writeStore(storePath, store);
    if (kind === 'full') io.writeKeyring(keys, keyringPath);
    if (encrypted) io.writeSecretsFile(encrypted, secretsFilePath);
  } catch (error) {
    const rollbackErrors = [];
    for (const path of [...paths].reverse()) {
      try {
        restoreSnapshot(path, snapshots.get(path));
      } catch (rollbackError) {
        rollbackErrors.push(`${path}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length) {
      error.message += `; rollback also failed (${rollbackErrors.join('; ')})`;
    }
    throw error;
  }

  return { keyringGroups: keys ? Object.keys(keys) : [], encrypted: Boolean(encrypted) };
}

// Keep each platform's two assignments contiguous so the block can be copied
// as dotenv text. Guidance follows the block instead of interrupting it.
const KEY_GUIDANCE = {
  fly: 'paste these two secrets into Fly',
  docker: "paste this block into the Dockge stack's .env",
  wrangler: 'add these two secrets to the Cloudflare Worker',
  deno: 'paste this block into the Deno Deploy environment import'
};
const PLATFORM_TITLES = Object.fromEntries(
  Object.entries(PLATFORM_META).map(([platform, { title }]) => [platform, title])
);

/**
 * The group keys, grouped into contiguous dotenv blocks for each platform.
 * These ARE secrets, so callers gate printing behind a confirmation exactly
 * like the credential reveal.
 */
export function formatKeysReveal(keys, only = null) {
  const platforms = only ? [only] : Object.keys(PLATFORM_GROUPS);
  const missing = missingGroups(keys, platforms);
  if (missing.length) return ['', `error: keyring is missing ${missing.join(', ')}; nothing printed`, ''].join('\n');
  const out = ['', 'Group keys — set each ONCE per platform.',
    dim('  They do not change when you rotate a secret; only a key rotation re-sets them.'), ''];

  for (const platform of Object.keys(PLATFORM_GROUPS)) {
    if (only && platform !== only) continue;
    out.push(bold(PLATFORM_TITLES[platform]));
    for (const { envName, value } of platformKeys(platform, keys)) out.push(`${envName}=${value}`);
    out.push(dim(`  ${KEY_GUIDANCE[platform]}`));
    out.push('');
  }
  return out.join('\n');
}

// ==========================================
// CLI
// ==========================================

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] || null;
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const storePath = argValue(argv, '--store')
    ? resolve(process.cwd(), argValue(argv, '--store'))
    : DEFAULT_STORE_PATH;
  const keyringPath = argValue(argv, '--keyring') || DEFAULT_KEYRING_PATH;
  const secretsFilePath = argValue(argv, '--secrets-file') || SECRETS_FILE_PATH;

  if (argv.includes('--push')) {
    const store = loadStoreOrEmpty(storePath);
    const plan = pushPlan(store);
    const names = platformNames();

    if (argv.includes('--yes')) {
      console.log(formatReveal(plan, store, names));
      return 0;
    }

    // Without a terminal there is no way to confirm, so refuse rather than
    // write credentials into whatever is on the other end of the pipe.
    if (!process.stdin.isTTY) {
      console.log(formatRevealPrompt(plan, names));
      console.error('error: refusing to print secrets without a confirmation; ' +
                    'run it on a terminal, or pass --yes');
      return 1;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const shown = await revealWithConfirmation(store, makeAsk(rl), (s) => console.log(s));
      return shown ? 0 : 0;
    } catch (e) {
      if (e instanceof Cancelled) { console.log('  (cancelled)'); return 130; }
      throw e;
    } finally {
      rl.close();
    }
  }

  if (argv.includes('--deno-env')) {
    // Writes a file, never prints a secret, so it is safe off a TTY.
    const path = exportDenoEnv(storePath, (s) => console.log(s), keyringPath);
    return path ? 0 : 1;
  }

  if (argv.includes('--docker-env')) {
    // Same file-only contract as --deno-env.
    const path = exportDockerEnv(storePath, (s) => console.log(s), keyringPath);
    return path ? 0 : 1;
  }

  if (argv.includes('--front-pin')) {
    // Probes the edge and prints a public fingerprint, so it is safe off a TTY.
    const store = loadStoreOrEmpty(storePath);
    const pin = await printFrontPin(store, (s) => console.log(s));
    return pin ? 0 : 1;
  }

  if (argv.includes('--init-keys')) {
    // Generating a keyring over an existing one would orphan every value already
    // encrypted under the old keys, so refuse unless forced.
    if (existsSync(keyringPath) && !argv.includes('--force')) {
      console.error(`error: ${keyringPath.replace(ROOT + '/', '')} already exists; ` +
                    're-run with --force to replace it (re-encrypts everything under new keys)');
      return 1;
    }
    const keys = generateKeys();
    writeKeyring(keys, keyringPath);
    console.log(`wrote ${keyringPath.replace(ROOT + '/', '')} (${storeMode(keyringPath)})`);
    // Encrypt whatever is already in the store under the new keys.
    const path = syncSecretsFile(loadStoreOrEmpty(storePath), keyringPath, secretsFilePath);
    if (path) console.log(`encrypted the store into ${path.replace(ROOT + '/', '')}`);
    console.log(dim('back this keyring up — without it, and without the plaintext store, ' +
                    'the committed ciphertext is unrecoverable'));
    return 0;
  }

  if (argv.includes('--encrypt')) {
    // Writes only the committed ciphertext, never a plaintext secret — safe off a TTY.
    const keys = readKeyring(keyringPath);
    if (!keys) { console.error('error: no keyring — run: node tools/credentials.mjs --init-keys'); return 1; }
    const path = writeSecretsFile(encryptStore(loadStoreOrEmpty(storePath), keys), secretsFilePath);
    console.log(`wrote ${path.replace(ROOT + '/', '')}`);
    return 0;
  }

  if (argv.includes('--decrypt')) {
    // Rebuild the local plaintext store from the committed file (fresh clone).
    // Writes only to the 0600 store, never to the terminal — safe off a TTY.
    const keys = readKeyring(keyringPath);
    if (!keys) { console.error('error: no keyring — you need the group keys to decrypt'); return 1; }
    const file = readSecretsFile(secretsFilePath);
    if (!file) { console.error(`error: no ${secretsFilePath.replace(ROOT + '/', '')} to decrypt`); return 1; }

    const decrypted = decryptSecretsFile(file, keys);
    let store = loadStoreOrEmpty(storePath);
    for (const [key, value] of Object.entries(decrypted)) store = withField(store, key, value);
    writeStore(storePath, store);
    console.log(`rebuilt ${storePath.replace(ROOT + '/', '')} from ${Object.keys(decrypted).length} decrypted value(s)`);
    return 0;
  }

  if (argv.includes('--keys')) {
    // The keys ARE secrets, so this reveals — gate it exactly like --push.
    const keys = readKeyring(keyringPath);
    if (!keys) { console.error('error: no keyring — run: node tools/credentials.mjs --init-keys'); return 1; }
    const only = argValue(argv, '--keys') && PLATFORM_GROUPS[argValue(argv, '--keys')]
      ? argValue(argv, '--keys') : null;
    const missing = missingGroups(keys, only ? [only] : Object.keys(PLATFORM_GROUPS));
    if (missing.length) {
      console.error(`error: keyring is missing ${missing.join(', ')}; refusing to print a partial set`);
      return 1;
    }

    if (argv.includes('--yes')) { console.log(formatKeysReveal(keys, only)); return 0; }
    if (!process.stdin.isTTY) {
      console.error('error: refusing to print keys without a confirmation; run it on a terminal, or pass --yes');
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await makeAsk(rl)('  Print the group keys to this terminal? [y/N] ')).toLowerCase();
      if (answer !== 'y' && answer !== 'yes') { console.log('  (nothing printed)'); return 0; }
      console.log(formatKeysReveal(keys, only));
      return 0;
    } catch (e) {
      if (e instanceof Cancelled) { console.log('  (cancelled)'); return 130; }
      throw e;
    } finally {
      rl.close();
    }
  }

  if (argv.includes('--import')) {
    const path = argValue(argv, '--import');
    if (!path) { console.error('error: --import needs a path'); return 64; }
    const imported = parseLegacyEnv(readFileSync(resolve(process.cwd(), path), 'utf8'), path);
    const store = loadStoreOrEmpty(storePath);
    const plan = planImport(store, imported);

    console.log(describeImport(plan));
    if (plan.differ.length && !argv.includes('--force')) {
      console.error('\nerror: keys differ from the store; re-run with --force to overwrite');
      return 1;
    }

    let updated = store;
    for (const [key, value] of Object.entries(imported)) updated = withField(updated, key, value);
    writeStore(storePath, updated);
    console.log(`\nimported into ${storePath.replace(ROOT + '/', '')}`);
    console.log(dim(`${path} is unchanged; archive it once you are satisfied`));
    return 0;
  }

  const store = loadStoreOrEmpty(storePath);

  if (argv.includes('--status') || !process.stdin.isTTY) {
    // Off a TTY this is the whole behaviour: report and exit, never prompt.
    console.log(statusReport(store, storePath));
    if (!process.stdin.isTTY && !argv.includes('--status')) {
      console.error(dim('\nnot a terminal — run `npm run creds` to edit'));
    }
    return validateStore(store).length ? 1 : 0;
  }

  if (!existsSync(storePath) && existsSync(LEGACY_ENV)) {
    console.log(`\n${LEGACY_ENV.replace(ROOT + '/', '')} exists and there is no store yet.`);
    console.log(`Import it with:  node tools/credentials.mjs --import local/.env\n`);
  }

  // Some terminals have a TTY that cannot switch to raw mode; the dashboard
  // needs it, so degrade to the report rather than crash mid-switch.
  if (typeof process.stdin.setRawMode !== 'function') {
    console.log(statusReport(store, storePath));
    console.error(dim('\nthis terminal cannot enter raw mode — showing the report instead'));
    return validateStore(store).length ? 1 : 0;
  }

  // Ink (and React with it) loads only here — never for a flag, a pipe, or a
  // script, which is what keeps the non-interactive contracts above cheap and
  // true.
  const { runTui } = await import('./tui/index.mjs');
  return runTui({ storePath, store, pathLabel: storePath.replace(ROOT + '/', '') });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof StoreError ? `error: ${e.message}` : e);
      process.exit(1);
    }
  );
}

export { Cancelled, makeAsk };
