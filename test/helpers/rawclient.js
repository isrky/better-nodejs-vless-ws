'use strict';

// Raw socket helpers for the black-box server tests.
//
// The server speaks HTTP/1.1 directly on a net.Socket (there is no http.Server
// involved), and it answers every non-WebSocket request with `Connection:
// close`. So "read until the socket closes" is a complete response, which is
// all these helpers do.

const net = require('net');
const tls = require('tls');

const { createServer } = require('../../src/node/server.js');

/**
 * Start a server on an ephemeral port. Returns { port, handle, close }.
 * Always `await close()` in a test teardown or the runner will not exit.
 */
function startTestServer(options = {}) {
  return new Promise((resolve, reject) => {
    const handle = createServer(options);
    handle.server.once('error', reject);
    handle.server.listen(0, '127.0.0.1', () => {
      const { port } = handle.server.address();
      resolve({
        port,
        handle,
        close: () => new Promise((done) => handle.close(done))
      });
    });
  });
}

/** Collect everything the socket sends until it closes. */
function drain(socket, request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks)));
    socket.write(request);
  });
}

/** Send `request` over plaintext TCP and return the raw response bytes. */
function rawRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      drain(socket, request).then(resolve, reject);
    });
    socket.on('error', reject);
  });
}

/**
 * Same, but over TLS. Exercises the ClientHello (0x16) detection path in
 * server.js against the bundled self-signed certificate.
 */
function rawTlsRequest(port, request) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { port, host: '127.0.0.1', rejectUnauthorized: false },
      () => {
        drain(socket, request).then(resolve, reject);
      }
    );
    socket.on('error', reject);
  });
}

/** Split a raw HTTP response into its head text and body bytes. */
function splitResponse(raw) {
  const eoh = raw.indexOf('\r\n\r\n');
  if (eoh === -1) return { head: raw.toString('utf8'), body: Buffer.alloc(0) };
  return {
    head: raw.subarray(0, eoh).toString('utf8'),
    body: raw.subarray(eoh + 4)
  };
}

function get(path, extraHeaders = '') {
  return `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${extraHeaders}\r\n`;
}

// ==========================================
// Server-Sent Events
//
// drain() above waits for 'close', and an SSE socket never closes on its own —
// using it against the stream endpoint hangs the runner until it is killed.
// These read until a condition is met and then close the socket themselves.
// ==========================================

/**
 * Send `request` and resolve as soon as `until(buf)` is true, then destroy the
 * socket. The timeout is explicit and unref'd, we close on every exit path, and
 * 'close' is only a fallback — all three are what stop a stuck stream from
 * deadlocking teardown.
 */
function rawRequestUntil(port, request, until, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;

    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));

    const timer = setTimeout(() => finish(reject, new Error(
      `timed out after ${timeoutMs}ms; got ${Buffer.concat(chunks).length} bytes`
    )), timeoutMs);
    timer.unref();

    function finish(fn, arg) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(arg);
    }

    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (until(buf)) finish(resolve, buf);
    });
    socket.on('error', (e) => finish(reject, e));
    socket.on('close', () => finish(resolve, Buffer.concat(chunks)));
  });
}

/** Decode an HTTP/1.1 chunked body, stopping cleanly at a partial final chunk. */
function decodeChunked(body) {
  const out = [];
  let i = 0;
  for (;;) {
    const eol = body.indexOf('\r\n', i);
    if (eol === -1) break;
    const size = parseInt(body.subarray(i, eol).toString('ascii'), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = eol + 2;
    if (start + size > body.length) break;
    out.push(body.subarray(start, start + size));
    i = start + size + 2;
  }
  return Buffer.concat(out);
}

/** Read `count` `data:` events from an SSE endpoint and return them parsed. */
async function readSseEvents(port, path, count = 1, timeoutMs = 6000, cookie = '') {
  const raw = await rawRequestUntil(
    port,
    get(path, cookie ? `Cookie: ${cookie}\r\n` : ''),
    (buf) => {
      const { body } = splitResponse(buf);
      return (decodeChunked(body).toString('utf8').match(/^data: /gm) || []).length >= count;
    },
    timeoutMs
  );

  const { head, body } = splitResponse(raw);
  const events = decodeChunked(body)
    .toString('utf8')
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.replace(/^data: /gm, '')));

  return { head, events };
}

module.exports = {
  startTestServer,
  rawRequest,
  rawTlsRequest,
  rawRequestUntil,
  decodeChunked,
  readSseEvents,
  splitResponse,
  get
};
