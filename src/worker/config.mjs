import vless from '../vless.js';

const { uuidToBytes } = vless;

// Same default as the Node build, so `wrangler dev` works with zero setup.
// Anything reachable from the internet must override it with a secret.
const DEFAULT_UUID = '7bd180e8-1142-4387-93f5-03e8d750a896';

let warnedDefault = false;

// Derived data keyed by its own input, so caching it at module scope is safe
// across requests in an isolate and saves 32 parseInt calls per connection.
let cachedUuidStr = null;
let cachedUuidBytes = null;

export function getUuidBytes(env) {
  let str = (env.UUID || '').trim();
  if (!str) {
    str = DEFAULT_UUID;
    if (!warnedDefault) {
      warnedDefault = true;
      console.warn('UUID secret is not set; falling back to the public default. Run: wrangler secret put UUID');
    }
  }
  if (str === cachedUuidStr) return cachedUuidBytes;
  const bytes = uuidToBytes(str);
  cachedUuidStr = str;
  cachedUuidBytes = bytes;
  return bytes;
}

export const getWsPath = (env) => env.WSPATH || '/';
export const getProxyIp = (env) => (env.PROXYIP || '').trim();
export const getDohUrl = (env) => env.DOH_URL || 'https://cloudflare-dns.com/dns-query';
