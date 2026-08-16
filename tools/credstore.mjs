// The credential store: schema, validation, redaction, generation, and safe I/O.
//
// Pure by construction — no readline, no process.stdin, no prompting. The
// renderer and the interactive tool both sit on top of this, which is what
// makes "the render path cannot block on input" a property rather than a hope.
//
// Everything secret the operator holds lives in one JSON file at mode 0600.
// It replaced a dotenv file that a human hand-edited and that shell also
// sourced; that dual-consumer arrangement is why the legacy parser below is so
// strict, and why it survives only for importing.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync,
  copyFileSync, openSync, writeSync, fsyncSync, closeSync, statSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CURRENT_VERSION = 1;
export const DEFAULT_STORE_PATH = resolve(ROOT, 'local/credentials.json');

// Published in this repo, so anyone can use it.
const PUBLISHED_UUID = '7bd180e8-1142-4387-93f5-03e8d750a896';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export class StoreError extends Error {}

function fail(msg) {
  throw new StoreError(msg);
}

// Reuse the server's own validators so the tool's rules cannot drift from the
// rules the running code enforces.
const lazy = {};
function users() {
  return (lazy.users ||= require(resolve(ROOT, 'src/node/users.js')));
}

// ==========================================
// Schema
// ==========================================

/**
 * `secret` drives redaction and the leak tests. `required` is required *for
 * rendering* — the server-side keys are optional here because a deployment
 * without provisioning is legitimate.
 *
 * `pushTo` records where a value has to end up, which is the whole content of
 * the push plan. Render-only fields push nowhere.
 */
export const FIELDS = [
  {
    key: 'UUID',
    group: 'render',
    secret: true,
    required: true,
    pushTo: ['fly', 'wrangler'],
    help: 'the tunnel credential; both deployments and every client config need it',
    generate: () => randomUUID(),
    validate: (v) => {
      if (!UUID_RE.test(v)) return 'must be a lowercase 8-4-4-4-12 UUID';
      if (v === PUBLISHED_UUID) return 'is the insecure default published in this repo';
      return null;
    }
  },
  {
    key: 'WSPATH',
    group: 'render',
    secret: true,
    required: true,
    pushTo: ['fly', 'wrangler'],
    help: 'the WebSocket path; obscurity only — the UUID is the credential',
    generate: () => '/' + randomBytes(16).toString('hex'),
    validate: (v) => {
      if (v.trim() === '') return 'is empty';
      if (/[\s#]/.test(v)) return 'contains whitespace or "#"';
      if (!v.startsWith('/')) return 'must start with /';
      return null;
    }
  },
  {
    key: 'FLY_HOST',
    group: 'render',
    secret: false,
    required: true,
    pushTo: [],
    help: 'hostname of the Fly deployment; used by the UDP-capable configs',
    validate: (v) => (HOST_RE.test(v) ? null : 'is not a bare lowercase hostname (no scheme, port or path)')
  },
  {
    key: 'WORKER_HOST',
    group: 'render',
    secret: false,
    required: true,
    pushTo: [],
    help: 'hostname of the Cloudflare Worker; used by the non-UDP configs',
    validate: (v) => (HOST_RE.test(v) ? null : 'is not a bare lowercase hostname (no scheme, port or path)')
  },
  {
    key: 'INTERCEPT_CA_FILE',
    group: 'render',
    secret: false,
    required: false,
    triState: true,
    pushTo: [],
    help: 'which CA goes into the client configs: bundled, none, or your own PEM',
    validate: (v) => {
      if (v === '') return null;                         // deliberately no pinned CA
      if (/\.(cer|der)$/i.test(v)) return 'looks like DER; convert it to PEM first';
      if (!existsSync(resolve(ROOT, v))) return 'does not exist';
      return null;
    }
  },
  {
    key: 'ADMIN_TOKEN',
    group: 'server',
    secret: true,
    required: false,
    pushTo: ['fly'],
    help: 'gates /admin-stats',
    generate: () => randomBytes(32).toString('base64'),
    validate: (v) => (/\s/.test(v) ? 'must not contain whitespace' : v === '' ? 'is empty' : null)
  },
  {
    key: 'PROVISION_SECRET',
    group: 'server',
    secret: true,
    required: false,
    pushTo: ['fly'],
    help: 'every provisioned user UUID is derived from this',
    generate: () => randomBytes(32).toString('base64'),
    validate: (v) => (/\s/.test(v) ? 'must not contain whitespace' : v === '' ? 'is empty' : null)
  },
  {
    key: 'PROVISION_SECRET_PREVIOUS',
    group: 'server',
    secret: true,
    required: false,
    pushTo: ['fly'],
    // Never generated: it only ever holds a value that was previously current,
    // so generating one would authenticate a credential nobody was ever issued.
    help: 'the previous provisioning secret, accepted during a rotation',
    validate: (v) => (v === '' ? 'is empty' : null)
  },
  {
    key: 'USERS',
    group: 'server',
    secret: false,
    required: false,
    pushTo: ['fly'],
    help: 'space or comma separated labels of provisioned users',
    validate: (v) => {
      const { labels, rejected } = users().parseUserLabels(v);
      if (rejected.length) return `has invalid labels: ${rejected.join(', ')}`;
      if (!labels.length) return 'has no valid labels';
      return null;
    },
    normalise: (v) => users().parseUserLabels(v).labels.join(' ')
  },
  {
    key: 'PROXYIP',
    group: 'server',
    secret: false,
    required: false,
    pushTo: ['wrangler'],
    help: 'relay host the Worker falls back to for Cloudflare-hosted origins',
    validate: (v) => {
      if (v.trim() === '') return 'is empty';
      if (/\s/.test(v)) return 'must not contain whitespace';
      return null;
    }
  }
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

export function field(key) {
  return BY_KEY.get(key) || null;
}

// ==========================================
// Values
// ==========================================

export function generate(key) {
  const f = field(key);
  if (!f || !f.generate) fail(`${key} cannot be generated`);
  return f.generate();
}

function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * How a value is shown. Never returns anything from which a secret could be
 * reconstructed — the fingerprint is there so two machines can be compared, and
 * so a truncated paste is visible.
 */
export function redact(key, value) {
  if (value === undefined) return 'unset';
  const f = field(key);

  if (key === 'INTERCEPT_CA_FILE') return value === '' ? 'none' : value;
  if (!f || !f.secret) return value === '' ? '(empty)' : value;

  if (key === 'UUID') return `${value.slice(0, 8)}-…`;
  if (key === 'WSPATH') return `/… (${value.length} chars)`;
  return `set (${value.length} chars #${fingerprint(value)})`;
}

export function validateField(key, value) {
  const f = field(key);
  if (!f) return null;                     // unmanaged keys are carried, not judged
  if (typeof value !== 'string') return 'must be a string';
  return f.validate ? f.validate(value) : null;
}

/** Every problem at once, for the status column. */
export function validateStore(store) {
  const c = store.credentials;
  const problems = [];

  for (const f of FIELDS) {
    const value = c[f.key];
    if (value === undefined) {
      if (f.required) problems.push({ key: f.key, level: 'error', reason: 'is missing' });
      continue;
    }
    const why = validateField(f.key, value);
    if (why) problems.push({ key: f.key, level: 'error', reason: why });
  }

  if (c.FLY_HOST !== undefined && c.FLY_HOST === c.WORKER_HOST) {
    problems.push({
      key: 'WORKER_HOST',
      level: 'error',
      reason: 'is identical to FLY_HOST — the -udp configs would point at the Worker, which carries no UDP'
    });
  }
  if (c.PROVISION_SECRET_PREVIOUS !== undefined &&
      c.PROVISION_SECRET_PREVIOUS === c.PROVISION_SECRET) {
    problems.push({
      key: 'PROVISION_SECRET_PREVIOUS',
      level: 'error',
      reason: 'is identical to PROVISION_SECRET'
    });
  }

  return problems;
}

/** Fail-fast for the renderer, reporting every problem in one message. */
export function requireRenderInputs(store) {
  const relevant = validateStore(store).filter((p) => {
    const f = field(p.key);
    return f && f.group === 'render';
  });

  if (relevant.length) {
    fail(`${relevant.length} problem(s) with the credential store:\n` +
         relevant.map((p) => `  ${p.key.padEnd(18)} ${p.reason}`).join('\n') +
         '\n\nRun: npm run creds');
  }

  const c = store.credentials;
  return { uuid: c.UUID, wsPath: c.WSPATH, hosts: { FLY_HOST: c.FLY_HOST, WORKER_HOST: c.WORKER_HOST } };
}

/**
 * The object the renderer's env-shaped consumers see.
 *
 * Copies with `in` semantics and never coerces. This is the single place the
 * INTERCEPT_CA_FILE tri-state is preserved: key absent means "bundled", `''`
 * means "no pinned CA", a path means that file. Anything that turned a missing
 * key into `''` here would silently strip the CA from every config, and that
 * failure only shows up on the intercepting network where it is required.
 */
export function toRenderEnv(store) {
  const env = Object.create(null);
  for (const [key, value] of Object.entries(store.credentials)) {
    if (value === null) fail(`${key} is null; use "" for empty or remove the key`);
    env[key] = value;
  }
  return env;
}

// ==========================================
// Store I/O
// ==========================================

export function emptyStore() {
  return { version: CURRENT_VERSION, credentials: {} };
}

export function readStore(path = DEFAULT_STORE_PATH) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') fail(`${path} not found. Run: npm run creds`);
    throw e;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(`${path} is not valid JSON (${e.message}). Restore ${path}.bak or run: npm run creds`);
  }

  // Never assume a version. A file whose shape we cannot identify is corrupt or
  // foreign, and treating it as empty would silently discard every credential.
  if (!Number.isInteger(parsed.version)) {
    fail(`${path} has no version field — refusing to guess its shape`);
  }
  if (parsed.version > CURRENT_VERSION) {
    fail(`${path} is version ${parsed.version}; this tool understands ${CURRENT_VERSION}. Upgrade the tool.`);
  }
  if (!parsed.credentials || typeof parsed.credentials !== 'object') {
    fail(`${path} has no credentials object`);
  }

  return { version: parsed.version, credentials: { ...parsed.credentials } };
}

export function writeStore(path, store) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(store, null, 2) + '\n';

  if (existsSync(path)) copyFileSync(path, path + '.bak');

  const tmp = path + '.tmp';
  let fd;
  try {
    fd = openSync(tmp, 'w', 0o600);
    writeSync(fd, text);
    // Without the flush, an unclean shutdown after the rename leaves a
    // zero-length file — which is every credential, gone.
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tmp)) unlinkSync(tmp);
    throw e;
  }

  // Catch a truncated write now rather than on the next run.
  if (readFileSync(path, 'utf8') !== text) {
    fail(`${path} did not read back identically — restore ${path}.bak`);
  }
}

export function restoreBackup(path) {
  const bak = path + '.bak';
  if (!existsSync(bak)) fail(`no ${bak} to restore`);
  copyFileSync(bak, path);
  return readStore(path);
}

export function storeMode(path) {
  try {
    return (statSync(path).mode & 0o777).toString(8).padStart(3, '0');
  } catch {
    return '---';
  }
}

/** Set, or delete when `value` is null. Returns a new store. */
export function withField(store, key, value) {
  const credentials = { ...store.credentials };
  if (value === null) delete credentials[key];
  else {
    const f = field(key);
    credentials[key] = f && f.normalise ? f.normalise(value) : value;
  }
  return { ...store, credentials };
}

// ==========================================
// Legacy dotenv import
// ==========================================

/**
 * Parse the retired `local/.env` format.
 *
 * Kept strict on purpose even though nothing sources it any more: the files it
 * reads were WRITTEN under these rules, and this is the highest-stakes read in
 * the tool — a divergence imports the wrong credential. Goes away when the last
 * .env does.
 */
export function parseLegacyEnv(text, label = '.env') {
  const out = Object.create(null);

  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const n = i + 1;
    if (line.trim() === '' || line.trim().startsWith('#')) return;

    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) fail(`${label}:${n}: not a KEY=value assignment`);

    const key = m[1];
    let value = m[2];
    if (key in out) fail(`${label}:${n}: duplicate key ${key} (shell would take the last)`);

    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.length < 2 || value[value.length - 1] !== quote) {
        fail(`${label}:${n}: unterminated ${quote === '"' ? 'double' : 'single'} quote`);
      }
      value = value.slice(1, -1);
      if (value.includes(quote)) fail(`${label}:${n}: embedded quote in ${key}`);
    } else if (/[\s$`"'\\;&|()<>*?#]/.test(value)) {
      fail(`${label}:${n}: ${key} has an unquoted shell metacharacter; quote it`);
    }

    out[key] = value;
  });

  return out;
}

/**
 * Classify what an import would do, by key and fingerprint only — never by
 * value. `unknown` keys are reported but still imported: dropping a key the
 * tool does not manage is the same failure as losing it.
 */
export function planImport(store, imported) {
  const plan = { add: [], same: [], differ: [], unknown: [] };

  for (const [key, value] of Object.entries(imported)) {
    if (!BY_KEY.has(key)) plan.unknown.push(key);

    const current = store.credentials[key];
    if (current === undefined) plan.add.push(key);
    else if (current === value) plan.same.push(key);
    else plan.differ.push({ key, current: fingerprint(current), incoming: fingerprint(value) });
  }

  return plan;
}

// ==========================================
// Push plan
// ==========================================

/**
 * What each platform calls itself, read from the committed config rather than
 * hardcoded.
 *
 * The Cloudflare one matters more than it looks: the dashboard project is named
 * by `name` in wrangler.toml, NOT by the route it serves — someone hunting for
 * "assets.isrky.dev" in the Workers list will not find it.
 */
export function platformNames(root = ROOT) {
  const read = (file, re, fallback) => {
    const path = resolve(root, file);
    if (!existsSync(path)) return fallback;
    const m = readFileSync(path, 'utf8').match(re);
    return m ? m[1] : fallback;
  };

  return {
    fly: read('fly.toml', /^\s*app\s*=\s*['"]([^'"]+)['"]/m, '<your fly app>'),
    worker: read('wrangler.toml', /^\s*name\s*=\s*['"]([^'"]+)['"]/m, '<your worker>')
  };
}

/**
 * Which keys go where. Deliberately carries no values.
 *
 * Values belong to the presentation layer, not here — that is what keeps the
 * table-driven sentinel test able to serialise this whole object and assert no
 * secret appears in it.
 */
export function pushPlan(store) {
  const set = (target) => FIELDS
    .filter((f) => f.pushTo.includes(target) && store.credentials[f.key] !== undefined)
    .map((f) => f.key);

  const renderOnly = FIELDS
    .filter((f) => f.pushTo.length === 0 && store.credentials[f.key] !== undefined)
    .map((f) => f.key);

  return { fly: set('fly'), wrangler: set('wrangler'), renderOnly, warnings: publicHostWarnings(store) };
}

/**
 * fly.toml's PUBLIC_HOST and the store's FLY_HOST are the same fact with
 * nothing keeping them in sync, and the drift is silent: the server falls back
 * to the request Host header, so provisioned invitees get configs pointing at
 * the wrong hostname while everything looks fine to the operator.
 */
export function publicHostWarnings(store, root = ROOT) {
  const flyToml = resolve(root, 'fly.toml');
  if (!existsSync(flyToml) || store.credentials.FLY_HOST === undefined) return [];

  const m = readFileSync(flyToml, 'utf8').match(/^\s*PUBLIC_HOST\s*=\s*['"]([^'"]+)['"]/m);
  if (!m) {
    return ['fly.toml has no PUBLIC_HOST; /admin-stats/provision will fall back to the request Host header'];
  }
  if (m[1] !== store.credentials.FLY_HOST) {
    return [`fly.toml PUBLIC_HOST is "${m[1]}" but FLY_HOST is "${store.credentials.FLY_HOST}" — ` +
            'edit fly.toml and redeploy, or new invites point at the wrong host'];
  }
  return [];
}
