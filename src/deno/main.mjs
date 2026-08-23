// Deno Deploy entry. The runtime-specific parts (WebSocket upgrade, env source,
// keep-alive, edge cache) live here; everything downstream is the shared Worker
// build in ../worker, reused unchanged. The only Cloudflare API those files
// import — `cloudflare:sockets` — is aliased to ../deno/sockets.mjs by the
// import map in deno.json.
//
// Capabilities match the Worker, not the Node build: TCP relay (CMD 1), DNS
// over DoH on port 53 (CMD 2), and mux-TCP (CMD 3). Deno Deploy has no UDP
// sockets, so general UDP is unsupported here exactly as on Cloudflare.

import vless from '../vless.js';
import { base64UrlToBytes } from '../worker/bytes.mjs';
import { getUuidBytes, getWsPath } from '../worker/config.mjs';
import { runDnsRelay } from '../worker/dns.mjs';
import { runMuxSession } from '../worker/mux.mjs';
import { decoyResponse } from '../worker/pages.mjs';
import { runTcpRelay } from '../worker/relay.mjs';
import { makeWsReadable, safeClose } from '../worker/wsstream.mjs';

const { ByteQueue, parseVlessHeader } = vless;

// The Worker reads config from an injected `env` object; Deno reads process
// environment. Build the same shape once so ../worker/config.mjs is reused as
// is. Read lazily-ish at startup — Deno Deploy sets these before first request.
const env = {
  UUID: Deno.env.get('UUID'),
  WSPATH: Deno.env.get('WSPATH'),
  PROXYIP: Deno.env.get('PROXYIP'),
  DOH_URL: Deno.env.get('DOH_URL')
};

// dns.mjs uses `caches.default` (a Cloudflare extension). Deno exposes the Web
// Cache API via caches.open() but no `.default`, so define it once. Kept
// non-enumerable/configurable in case the runtime later ships its own.
if (!('default' in caches)) {
  const dohCache = await caches.open('doh');
  Object.defineProperty(caches, 'default', { value: dohCache, configurable: true });
}

// dns.mjs and mux.mjs expect a Cloudflare-style ctx.waitUntil to keep a
// background promise alive past the response. On Deno the WebSocket keeps the
// handler's promises alive on its own, so this only needs to swallow rejections
// (an unhandled one inside the Worker's waitUntil would take the session down).
const ctx = {
  waitUntil(promise) {
    if (promise && typeof promise.catch === 'function') promise.catch(() => {});
  }
};

Deno.serve((request) => {
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
    return decoyResponse();
  }
  // Fail closed: with no credential there is nothing to authenticate against.
  const uuidBytes = getUuidBytes(env);
  if (!uuidBytes) return decoyResponse();

  // Same substring match as the other builds, so existing client configs and
  // the ?ed=2048 early-data suffix keep resolving.
  const url = new URL(request.url);
  if (!url.pathname.includes(getWsPath(env))) return decoyResponse();

  // Read every header off the request BEFORE upgrading: Deno.upgradeWebSocket
  // hijacks the request, and touching request.headers afterwards throws
  // "Request closed". (Cloudflare's WebSocketPair left the request intact, so
  // the Worker could read this later — one of the few ordering differences.)
  //
  // ?ed=2048 clients smuggle their first payload into the handshake as
  // base64url. A malformed value is treated as simply absent.
  let earlyData = null;
  const protocol = request.headers.get('sec-websocket-protocol');
  if (protocol) {
    try { earlyData = base64UrlToBytes(protocol.trim()); } catch { earlyData = null; }
  }

  const { socket, response } = Deno.upgradeWebSocket(request);
  // wsstream.mjs does `new Uint8Array(event.data)` for binary frames, which
  // needs an ArrayBuffer rather than a Blob.
  socket.binaryType = 'arraybuffer';

  const readable = makeWsReadable(socket, earlyData);
  // Not awaited: the relay is driven by WebSocket events, which keep the
  // connection (and this promise) alive until the socket closes.
  pump(socket, readable, uuidBytes).catch(() => safeClose(socket));

  return response;
});

/** Accumulate until the VLESS header is complete, then hand off by command. */
async function pump(ws, readable, uuidBytes) {
  const reader = readable.getReader();
  const queue = new ByteQueue();

  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      safeClose(ws);
      return;
    }
    queue.push(value);

    const buf = queue.flatten();
    const result = parseVlessHeader(buf, uuidBytes);
    if (result.status === 'need') continue;

    if (result.status === 'fail') {
      console.log('vless rejected: ' + result.reason);
      safeClose(ws, 1002, 'bad request');
      return;
    }

    const initial = buf.slice(result.headerEnd);
    reader.releaseLock();

    if (result.cmd === 1) {
      console.log(`tcp ${result.host}:${result.port}`);
      return runTcpRelay(ws, readable, result.host, result.port, initial, env);
    }
    if (result.cmd === 2) {
      console.log(`udp ${result.host}:${result.port}`);
      return runDnsRelay(ws, readable, result.port, initial, env, ctx);
    }
    console.log('mux session started');
    return runMuxSession(ws, readable, initial, env, ctx);
  }
}
