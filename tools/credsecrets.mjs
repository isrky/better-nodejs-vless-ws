// Encrypt the credential store into the committed, group-encrypted secrets
// file, and the inverse. Pure by construction like credstore.mjs — no prompting,
// no process.env; the CLI/TUI layers drive it.
//
// This is the one place encryption happens. The runtime builds only decrypt
// (src/node/secrets.js with node:crypto; src/worker/secrets.mjs with Web
// Crypto), and both read the format this module writes. The on-disk contract:
// AES-256-GCM, a random 12-byte IV per value, and the 16-byte tag APPENDED to
// the ciphertext (Web Crypto's convention), all base64. A test round-trips this
// against both runtime decrypters.

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GROUPS, PLATFORM_GROUPS, groupOf, DEFAULT_STORE_PATH, StoreError,
  writeEnvFile
} from './credstore.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CURRENT_VERSION = 1;
// Committed. Lives under src/node/ so `COPY src/node/` ships it in the Docker
// image and the Node runtime can require it; the Worker/Deno builds import it.
export const SECRETS_FILE_PATH = resolve(ROOT, 'src/node/secrets.enc.json');
// The local keyring: the three group keys, next to the plaintext store. Never
// committed (local/ is gitignored). Losing it — without the plaintext store —
// makes the committed ciphertext unrecoverable, so it is as critical as the store.
export const DEFAULT_KEYRING_PATH = resolve(dirname(DEFAULT_STORE_PATH), 'secrets.keys.json');

const KEY_BYTES = 32;   // AES-256
const IV_BYTES = 12;    // GCM standard nonce
const TAG_BYTES = 16;

function fail(msg) {
  throw new StoreError(msg);
}

// ==========================================
// Keys
// ==========================================

/** A fresh random key per group, base64. */
export function generateKeys() {
  const keys = {};
  for (const group of Object.keys(GROUPS)) keys[group] = randomBytes(KEY_BYTES).toString('base64');
  return keys;
}

function keyBytes(b64, group) {
  const buf = Buffer.from(String(b64), 'base64');
  if (buf.length !== KEY_BYTES) fail(`the ${group} key is not a 32-byte base64 key`);
  return buf;
}

export function readKeyring(path = DEFAULT_KEYRING_PATH) {
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`${path} is not valid JSON (${e.message})`);
  }
  if (!parsed || typeof parsed.keys !== 'object') fail(`${path} has no keys object`);
  return parsed.keys;
}

/** Write the keyring 0600 + atomically, reusing the store's durable writer. */
export function writeKeyring(keys, path = DEFAULT_KEYRING_PATH) {
  writeEnvFile(path, JSON.stringify({ version: CURRENT_VERSION, keys }, null, 2) + '\n');
  return path;
}

// ==========================================
// Value encryption (the format contract)
// ==========================================

export function encryptValue(key, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), ct: Buffer.concat([ct, tag]).toString('base64') };
}

export function decryptValue(key, enc) {
  const iv = Buffer.from(enc.iv, 'base64');
  const blob = Buffer.from(enc.ct, 'base64');
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const data = blob.subarray(0, blob.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ==========================================
// Store <-> file
// ==========================================

/**
 * Build the committed file object from the store: for each group, encrypt every
 * shared-secret field that is actually set. Unset fields are simply absent, so
 * the file mirrors the store and never carries an empty placeholder.
 */
export function encryptStore(store, keys) {
  const groups = {};
  for (const [group, fields] of Object.entries(GROUPS)) {
    const key = keyBytes(keys[group], group);
    const values = {};
    for (const field of fields) {
      const value = store.credentials[field];
      if (value === undefined) continue;
      values[field] = encryptValue(key, value);
    }
    if (Object.keys(values).length) groups[group] = values;
  }
  return { v: CURRENT_VERSION, alg: 'AES-256-GCM', groups };
}

/**
 * The tool-side mirror of the runtime decrypt: recover `{ FIELD: value }` from
 * the file for every group we hold a key for. Used by --decrypt to rebuild the
 * local plaintext store on a fresh clone.
 */
export function decryptSecretsFile(fileObj, keys) {
  const out = {};
  if (!fileObj || !fileObj.groups) return out;
  for (const [group, values] of Object.entries(fileObj.groups)) {
    if (!keys[group]) continue;
    const key = keyBytes(keys[group], group);
    for (const [field, enc] of Object.entries(values)) out[field] = decryptValue(key, enc);
  }
  return out;
}

/** Write the committed file (pretty JSON, a normal tracked file — not 0600). */
export function writeSecretsFile(obj, path = SECRETS_FILE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  return path;
}

export function readSecretsFile(path = SECRETS_FILE_PATH) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`${path} is not valid JSON (${e.message})`);
  }
}

// ==========================================
// Reveal (set-once, per platform)
// ==========================================

/** The env-var name a group's key is set under. Matches src/node/secrets.js. */
export function keyEnvName(group) {
  return 'SECRETS_KEY_' + group.toUpperCase();
}

/**
 * The two keys a platform needs, as `{ envName, value }` pairs. Deliberately
 * carries the key material — callers gate printing behind a confirmation the
 * same way the secret reveal does.
 */
export function platformKeys(platform, keys) {
  const groups = PLATFORM_GROUPS[platform];
  if (!groups) fail(`unknown platform ${platform}`);
  return groups.map((group) => ({ group, envName: keyEnvName(group), value: keys[group] }));
}

export { GROUPS, PLATFORM_GROUPS, groupOf };
