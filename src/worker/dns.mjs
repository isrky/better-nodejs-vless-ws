import vless from '../vless.js';
import { bytesToBase64Url, lengthPrefixed } from './bytes.mjs';
import { getDohUrl } from './config.mjs';
import { safeClose, safeSend } from './wsstream.mjs';

const { ByteQueue, VLESS_OK_HEADER, concat } = vless;

const DOH_ACCEPT = { accept: 'application/dns-message' };

/**
 * Resolve one raw DNS query (RFC 1035 wire format) over DoH.
 *
 * The edge cache here is load-bearing, not an optimization: a Worker gets 50
 * subrequests per request on the free plan and one WebSocket session is one
 * request, so uncached queries would exhaust the budget within seconds of
 * browsing and kill the tunnel. Cache hits are not subrequests.
 */
export async function dohQuery(query, env, ctx) {
  if (query.byteLength < 12) throw new Error('short dns query');

  // Cache key is the query with its transaction ID zeroed (RFC 8484 §4.1),
  // so two clients asking the same question share one cached answer.
  const key = query.slice();
  key[0] = 0;
  key[1] = 0;

  const request = new Request(`${getDohUrl(env)}?dns=${bytesToBase64Url(key)}`, {
    method: 'GET',
    headers: DOH_ACCEPT
  });

  const cache = caches.default;
  let response = await cache.match(request);
  if (!response) {
    response = await fetch(request);
    // The cache write must outlive this response; this is what waitUntil is
    // for. It must not be allowed to reject: cache.put throws on responses the
    // upstream marked uncacheable, and an unhandled rejection inside waitUntil
    // takes the whole session down with it.
    if (response.ok) ctx.waitUntil(cache.put(request, response.clone()).catch(() => {}));
  }
  if (!response.ok) throw new Error('doh status ' + response.status);

  const answer = new Uint8Array(await response.arrayBuffer());
  if (answer.length >= 2) {
    answer[0] = query[0];
    answer[1] = query[1];
  }
  return answer;
}

/**
 * VLESS CMD 2. The payload is a stream of 2-byte big-endian length-prefixed
 * UDP packets, all addressed to the host:port from the VLESS header, and
 * replies use the same framing.
 *
 * Workers has no UDP, so only DNS is serviceable — everything else is refused.
 */
export async function runDnsRelay(ws, readable, port, initial, env, ctx) {
  if (port !== 53) {
    console.log('udp rejected: only port 53 is supported on Workers');
    safeClose(ws, 1003, 'udp unsupported');
    return;
  }

  let header = VLESS_OK_HEADER;
  const queue = new ByteQueue();
  // In-flight lookups are tracked so the session can await them on teardown.
  // A promise that outlives its request context is cancelled by the runtime
  // and reported as a hung Worker.
  const inFlight = new Set();
  if (initial && initial.byteLength) queue.push(initial);

  const reply = (answer) => {
    const framed = lengthPrefixed(answer);
    if (header) {
      safeSend(ws, concat(header, framed));
      header = null;
    } else {
      safeSend(ws, framed);
    }
  };

  const drain = () => {
    for (;;) {
      if (queue.size < 2) return;
      const len = (queue.at(0) << 8) | queue.at(1);
      if (queue.size < 2 + len) return;
      // A copy, not a view: consume() below re-slices the backing store.
      const packet = queue.slice(2, 2 + len);
      queue.consume(2 + len);
      // Deliberately not awaited so queries resolve in parallel. JS is
      // single-threaded, so the `header` check inside reply() stays race-free.
      //
      // A failed query is dropped rather than closing the session: that is
      // ordinary packet loss as far as the client's resolver is concerned, and
      // it will retry. Logging keeps a broken DOH_URL from looking like a hang.
      const task = dohQuery(packet, env, ctx)
        .then(reply)
        .catch((err) => {
          console.log('doh query failed: ' + (err && err.message ? err.message : err));
        })
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
  };

  drain();

  try {
    await readable.pipeTo(new WritableStream({
      write(chunk) {
        queue.push(chunk);
        drain();
      }
    }));
  } catch {}

  if (inFlight.size) await Promise.allSettled([...inFlight]);
  safeClose(ws);
}
