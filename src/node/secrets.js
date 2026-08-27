'use strict';

// Runtime decryption of the committed, group-encrypted secrets file.
//
// The operator's secrets live encrypted in src/node/secrets.enc.json (committed,
// synced through git). Each group (common/server/edge) is encrypted under its
// own 256-bit key; a deployment holds only its groups' keys, as SECRETS_KEY_*
// env vars, and decrypts what it can on boot. A deployment never carries the
// secret values themselves — only the keys.
//
// Built-ins only (crypto, fs, path): this module ships inside the Docker image,
// which runs no `npm install`, so it must not require any package. AES-256-GCM
// via the classic (synchronous) node:crypto API keeps boot synchronous — the
// same reason config.js stays sync. The on-disk format is byte-compatible with
// the Web Crypto path the Worker/Deno builds use (see src/worker/secrets.mjs):
// the 16-byte GCM tag is appended to the ciphertext, Web Crypto's convention.

const { createDecipheriv } = require('crypto');
const { readFileSync } = require('fs');
const { join } = require('path');

const SECRETS_FILE = join(__dirname, 'secrets.enc.json');
const TAG_BYTES = 16;

/** group name (as written in the file) → the env var holding its key. */
function keyEnvName(group) {
  return 'SECRETS_KEY_' + group.toUpperCase();
}

/**
 * Decrypt one `{ iv, ct }` value. `ct` is base64(ciphertext || 16-byte tag).
 * Throws on a wrong key or tampered data (GCM authentication) — callers that
 * want fail-closed behaviour catch per group.
 */
function decryptValue(key, enc) {
  const iv = Buffer.from(enc.iv, 'base64');
  const blob = Buffer.from(enc.ct, 'base64');
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const data = blob.subarray(0, blob.length - TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Load and parse the committed file, or null when it is absent/unreadable. */
function loadSecretsFile() {
  try {
    return JSON.parse(readFileSync(SECRETS_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;   // not set up yet — behave as no secrets
    throw e;
  }
}

/**
 * Decrypt every group whose key is present in `env`, returning a plain
 * `{ FIELD: value }` map. A no-op — returns `{}` — when the file is absent or
 * no SECRETS_KEY_* is set, so a deployment (or a test) with no keys behaves
 * exactly as it did before this file existed.
 *
 * Fail-closed per group: a missing or wrong key leaves that group's fields
 * unset rather than throwing here. config.js then refuses to boot the Node build
 * if a SECRETS_KEY_* is set but UUID did not decrypt — closing the door on the
 * published DEFAULT_UUID fallback (which would otherwise be an open proxy on a
 * well-known credential). The failure is announced on stderr (group name only,
 * never key material) so the misconfiguration is visible.
 *
 * @param env      the environment to read SECRETS_KEY_* from (default process.env)
 * @param fileObj  parsed file to decrypt (default: the committed file); for tests
 */
function decryptSecrets(env = process.env, fileObj = loadSecretsFile()) {
  const out = {};
  if (!fileObj || !fileObj.groups) return out;

  for (const [group, values] of Object.entries(fileObj.groups)) {
    const b64 = env[keyEnvName(group)];
    if (!b64) continue;                       // no key for this group — skip it

    const key = Buffer.from(b64, 'base64');
    const decrypted = {};
    try {
      for (const [field, enc] of Object.entries(values)) {
        decrypted[field] = decryptValue(key, enc);
      }
    } catch {
      // A wrong key fails the whole group; apply none of it (fail closed).
      process.stderr.write(
        `secrets: could not decrypt the "${group}" group — check ${keyEnvName(group)}\n`
      );
      continue;
    }
    Object.assign(out, decrypted);
  }
  return out;
}

module.exports = { decryptSecrets, decryptValue, keyEnvName, SECRETS_FILE };
