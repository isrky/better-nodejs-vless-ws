export const WS_OPEN = 1;

// The Workers WebSocket is push-only: there is no equivalent of the Node
// build's client.pause(), so a fast uploader against a slow origin grows this
// queue against a 128 MB isolate limit. Killing one connection beats taking
// down the isolate for everyone sharing it.
const MAX_BACKLOG = 8 * 1024 * 1024;

const ENC = new TextEncoder();

/**
 * Adapt an accepted server-side WebSocket to a ReadableStream of Uint8Array,
 * so the rest of the relay can use pipeTo and get backpressure handling for
 * free on the outbound side.
 */
export function makeWsReadable(ws, earlyData) {
  let finished = false;
  let backlog = 0;

  return new ReadableStream({
    start(controller) {
      if (earlyData && earlyData.byteLength) {
        backlog += earlyData.byteLength;
        controller.enqueue(earlyData);
      }

      ws.addEventListener('message', (event) => {
        if (finished) return;
        const data = event.data;
        const chunk = typeof data === 'string' ? ENC.encode(data) : new Uint8Array(data);
        backlog += chunk.byteLength;
        if (backlog > MAX_BACKLOG) {
          finished = true;
          try { controller.error(new Error('client backlog exceeded')); } catch {}
          safeClose(ws);
          return;
        }
        controller.enqueue(chunk);
      });

      ws.addEventListener('close', () => {
        if (finished) return;
        finished = true;
        try { controller.close(); } catch {}
      });

      ws.addEventListener('error', (err) => {
        if (finished) return;
        finished = true;
        try { controller.error(err); } catch {}
      });
    },

    pull() {
      // The consumer drained what it had; reset the guard's accounting.
      backlog = 0;
    },

    cancel() {
      finished = true;
      safeClose(ws);
    }
  });
}

/**
 * Swallow a rejection from a teardown call. Socket/writer close() and abort()
 * return promises, so a synchronous try/catch around them does nothing and the
 * rejection surfaces as an uncaught error.
 */
export function ignoreRejection(result) {
  if (result && typeof result.catch === 'function') result.catch(() => {});
}

export function safeClose(ws, code = 1000, reason = '') {
  try {
    if (ws.readyState === WS_OPEN) ws.close(code, reason);
  } catch {}
}

/** Send only if the socket is still usable; returns false once it isn't. */
export function safeSend(ws, payload) {
  if (ws.readyState !== WS_OPEN) return false;
  try {
    ws.send(payload);
    return true;
  } catch {
    return false;
  }
}
