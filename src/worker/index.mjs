import vless from '../vless.js';
import { base64UrlToBytes } from './bytes.mjs';
import { getUuidBytes, getWsPath } from './config.mjs';
import { runDnsRelay } from './dns.mjs';
import { runMuxSession } from './mux.mjs';
import { decoyResponse } from './pages.mjs';
import { runTcpRelay } from './relay.mjs';
import { makeWsReadable, safeClose } from './wsstream.mjs';

const { ByteQueue, parseVlessHeader } = vless;

export default {
  async fetch(request, env, ctx) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return decoyResponse();
    }
    // Same substring match as the Node build, so existing client configs and
    // the ?ed=2048 early-data suffix keep resolving.
    const url = new URL(request.url);
    if (!url.pathname.includes(getWsPath(env))) return decoyResponse();

    return handleVless(request, env, ctx);
  }
};

function handleVless(request, env, ctx) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  // Clients using ?ed=2048 smuggle their first payload into the handshake as
  // base64url, which saves a full client-to-edge round trip before we can even
  // start dialling. Treat a malformed value as simply absent.
  let earlyData = null;
  const protocol = request.headers.get('sec-websocket-protocol');
  if (protocol) {
    try { earlyData = base64UrlToBytes(protocol.trim()); } catch { earlyData = null; }
  }

  const readable = makeWsReadable(server, earlyData);

  // waitUntil is required, not belt-and-braces: returning the 101 ends the
  // request context, and without this the runtime cancels the relay before it
  // has read a single byte.
  ctx.waitUntil(pump(server, readable, env, ctx).catch(() => safeClose(server)));

  return new Response(null, { status: 101, webSocket: client });
}

/** Accumulate until the VLESS header is complete, then hand off by command. */
async function pump(ws, readable, env, ctx) {
  const reader = readable.getReader();
  const queue = new ByteQueue();
  const uuidBytes = getUuidBytes(env);

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
      // A pre-upgrade rejection would serve the decoy page, but nothing can be
      // sent as HTML after a 101 — so this becomes a protocol-error close.
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
