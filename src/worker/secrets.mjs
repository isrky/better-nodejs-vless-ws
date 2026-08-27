// Runtime decryption for the Worker and Deno builds.
//
// The twin of src/node/secrets.js, using Web Crypto (AES-GCM) because that is
// what these runtimes expose — and because it needs no Node shim, so wrangler
// stays Buffer-free. The on-disk format is identical (a test round-trips both
// ways): a 12-byte IV, and the 16-byte tag appended to the ciphertext, which is
// exactly what subtle.decrypt expects.
//
// The ciphertext is imported by each entry point (index.mjs / main.mjs) in the
// JSON form its bundler wants and handed in, so this module carries no
// runtime-specific import.

function keyEnvName(group) {
  return 'SECRETS_KEY_' + group.toUpperCase();
}

// atob → bytes, no Buffer (the Worker build is deliberately Buffer-free).
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Decrypt every group whose SECRETS_KEY_* is present in `env`, returning a plain
 * `{ FIELD: value }`. Pure and stateless (no cache) so it is unit-testable.
 * Fail-closed per group: a wrong key leaves that group's fields out rather than
 * throwing, matching the Node runtime.
 */
export async function decryptGroups(env, cipher) {
  const out = {};
  if (!cipher || !cipher.groups) return out;

  for (const [group, values] of Object.entries(cipher.groups)) {
    const b64 = env[keyEnvName(group)];
    if (!b64) continue;
    try {
      const key = await crypto.subtle.importKey(
        'raw', b64ToBytes(b64), { name: 'AES-GCM' }, false, ['decrypt']
      );
      const decrypted = {};
      for (const [field, enc] of Object.entries(values)) {
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: b64ToBytes(enc.iv) }, key, b64ToBytes(enc.ct)
        );
        decrypted[field] = new TextDecoder().decode(plain);
      }
      Object.assign(out, decrypted);
    } catch {
      console.warn(`secrets: could not decrypt the "${group}" group — check ${keyEnvName(group)}`);
    }
  }
  return out;
}

// Module-scoped cache: decrypt once per isolate, on the first request (Worker)
// or at startup (Deno). env and the bundled cipher are stable for the isolate's
// life, so a single init is safe and keeps the config accessors synchronous.
let cache = {};
let initialised = false;

export async function ensureSecrets(env, cipher) {
  if (initialised) return;
  initialised = true;
  cache = await decryptGroups(env, cipher);
}

/** A decrypted value, or undefined when this deployment has no key for it. */
export function secretValue(field) {
  return Object.prototype.hasOwnProperty.call(cache, field) ? cache[field] : undefined;
}

// Test-only: reset the one-shot cache between cases.
export function _resetForTest() {
  cache = {};
  initialised = false;
}
