import { connect } from 'cloudflare:sockets';
import vless from '../vless.js';
import { WS_OPEN, ignoreRejection, safeClose, safeSend } from './wsstream.mjs';
import { getProxyIp } from './config.mjs';

const { VLESS_OK_HEADER, concat } = vless;

async function dial(hostname, port) {
  const socket = connect({ hostname, port });
  // Surfaces connect failures here as a rejection, replacing the Node build's
  // 'error' event on net.createConnection.
  await socket.opened;
  return { socket, writer: socket.writable.getWriter() };
}

/**
 * PROXYIP is either "host" (reuse the original destination port) or
 * "host:port". Bracketed IPv6 literals are supported.
 */
function splitProxy(proxyIp, fallbackPort) {
  const m = /^\[(.+)\](?::(\d+))?$/.exec(proxyIp);
  if (m) return { hostname: m[1], port: m[2] ? parseInt(m[2], 10) : fallbackPort };
  const idx = proxyIp.lastIndexOf(':');
  if (idx > 0 && proxyIp.indexOf(':') === idx) {
    return { hostname: proxyIp.slice(0, idx), port: parseInt(proxyIp.slice(idx + 1), 10) || fallbackPort };
  }
  return { hostname: proxyIp, port: fallbackPort };
}

/**
 * VLESS CMD 1. Relays the WebSocket byte stream to a TCP destination.
 *
 * pipeTo with an awaited writer.ready is what replaces the Node build's manual
 * pause()/resume()/drain choreography — backpressure comes for free.
 */
export async function runTcpRelay(ws, readable, host, port, initial, env) {
  let header = VLESS_OK_HEADER;
  let sawData = false;

  // Held in a mutable cell so the PROXYIP retry can swap the upstream target
  // out from under the in-flight pipeTo.
  let current = null;

  async function openTo(hostname, dport) {
    const entry = await dial(hostname, dport);
    if (initial && initial.byteLength) {
      await entry.writer.ready;
      await entry.writer.write(initial);
    }
    return entry;
  }

  async function pumpDown(entry) {
    await entry.socket.readable.pipeTo(new WritableStream({
      write(chunk) {
        if (ws.readyState !== WS_OPEN) throw new Error('websocket closed');
        sawData = true;
        if (header) {
          safeSend(ws, concat(header, chunk));
          header = null;
        } else {
          safeSend(ws, chunk);
        }
      }
    }));
  }

  try {
    current = await openTo(host, port);
  } catch {
    current = null;
  }

  const upstreamSink = () => new WritableStream({
    async write(chunk) {
      const writer = current.writer;
      await writer.ready;
      await writer.write(chunk);
    },
    close() { ignoreRejection(current.writer.close()); },
    abort() { ignoreRejection(current.writer.abort()); }
  });

  let upstream = Promise.resolve();
  if (current) {
    upstream = readable.pipeTo(upstreamSink()).catch(() => {});
    try { await pumpDown(current); } catch {}
  }

  // A dial that failed outright, or connected but returned nothing at all, is
  // the signature of a Cloudflare-proxied origin: Workers refuse to connect
  // back into Cloudflare's own edge on 80/443. Retry through a relay host.
  const proxyIp = getProxyIp(env);
  if (!sawData && proxyIp && ws.readyState === WS_OPEN) {
    const target = splitProxy(proxyIp, port);
    try {
      const next = await openTo(target.hostname, target.port);
      const previous = current;
      current = next;
      if (previous) {
        ignoreRejection(previous.socket.close());
      } else {
        // No upstream pipe was ever started, because the first dial failed.
        upstream = readable.pipeTo(upstreamSink()).catch(() => {});
      }
      await pumpDown(next);
    } catch {}
  }

  safeClose(ws);
  await upstream;
}
