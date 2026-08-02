import vless from '../vless.js';

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
  const str = (env.UUID || '').trim();
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
export const getWsPath = (env) => (env.WSPATH || '').trim() || '/';
export const getProxyIp = (env) => (env.PROXYIP || '').trim();
export const getDohUrl = (env) => env.DOH_URL || 'https://cloudflare-dns.com/dns-query';
