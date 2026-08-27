import vless from '../vless.js';
import { secretValue } from './secrets.mjs';

const { uuidToBytes } = vless;

let warned = false;

function warnOnce(message) {
  if (warned) return;
  warned = true;
  console.warn(message);
}

// Derived data keyed by its own input, so caching it at module scope is safe
// across requests in an isolate and saves 32 parseInt calls per connection.
let cachedUuidStr = null;
let cachedUuidBytes = null;

/**
 * The configured UUID as 16 bytes, or null when none is usable.
 *
 * There is deliberately no built-in default. This source is public, so any
 * fallback baked in here would be a published credential — a Worker deployed
 * before its secret was set would be an open proxy for anyone who read the
 * repository. Callers must treat null as "refuse to proxy".
 */
export function getUuidBytes(env) {
  // A decrypted secret (from the committed file, if this deployment holds the
  // common key) takes precedence; otherwise fall back to a raw env var, so a
  // deployment that has not adopted the encrypted file behaves as before.
  // ensureSecrets(env, cipher) must have run first (see index.mjs / main.mjs).
  const str = (secretValue('UUID') ?? env.UUID ?? '').trim();
  if (!str) {
    warnOnce('UUID is not configured — refusing all proxy requests. Set it with: wrangler secret put UUID');
    return null;
  }
  if (str === cachedUuidStr) return cachedUuidBytes;

  let bytes;
  try {
    bytes = uuidToBytes(str);
  } catch {
    warnOnce('UUID is malformed — refusing all proxy requests. Expected 32 hex digits, with or without dashes.');
    return null;
  }

  cachedUuidStr = str;
  cachedUuidBytes = bytes;
  return bytes;
}

// Matched as a substring of the request path, so a leading slash is optional.
// Usually set as a secret rather than a committed var — see wrangler.toml.
export const getWsPath = (env) => (secretValue('WSPATH') ?? env.WSPATH ?? '').trim() || '/';
export const getProxyIp = (env) => (secretValue('PROXYIP') ?? env.PROXYIP ?? '').trim();
// DOH_URL is per-deployment config, never a shared encrypted secret — env only.
export const getDohUrl = (env) => env.DOH_URL || 'https://cloudflare-dns.com/dns-query';
