'use strict';

// Minimal HTTP/1.1 request-head parsing and response writing.
//
// The server owns its socket directly (no http.Server), because after the
// WebSocket upgrade the connection stops being HTTP entirely. Only the head of
// the first request is ever parsed.
//
// Everything here is Uint8Array-safe on input: bytes arrive from a ByteQueue
// (src/vless.js), whose flatten()/slice() return plain Uint8Array, not Buffer.
// Buffer-only methods like `.indexOf(Buffer)` and `.toString('utf8', a, b)`
// FAIL SILENTLY on a Uint8Array — the first returns -1, the second ignores its
// arguments — so they must not be used on that input.

const crypto = require('crypto');

const DEC = new TextDecoder();

// CR LF CR LF
const CRLFCRLF = Uint8Array.from([0x0d, 0x0a, 0x0d, 0x0a]);

const STATUS_TEXT = {
  200: 'OK',
  400: 'Bad Request',
  301: 'Moved Permanently',
  302: 'Found',
  404: 'Not Found'
};

/**
 * Index of the \r\n\r\n that terminates the request head, or -1.
 *
 * Hand-rolled rather than Buffer#indexOf so it works on any Uint8Array. Note
 * it must match CRLFCRLF exactly — a bare \n\n is not a valid HTTP head
 * terminator and must not match.
 */
function indexOfHeaderEnd(bytes, from = 0) {
  const limit = bytes.length - 3;
  for (let i = Math.max(0, from); i < limit; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a &&
        bytes[i + 2] === 0x0d && bytes[i + 3] === 0x0a) {
      return i;
    }
  }
  return -1;
}

/**
 * Parse a request head (the bytes up to and including \r\n\r\n).
 *
 * Returns null if the request line is missing. Header names are lowercased;
 * a repeated header keeps the last value, matching the original behaviour.
 */
function parseRequestHead(bytes) {
  const lines = DEC.decode(bytes).split('\r\n');
  const reqLine = lines[0];
  if (!reqLine) return null;

  const parts = reqLine.split(' ');
  const method = parts[0];
  const path = parts[1];
  if (!method || !path) return null;

  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }

  const q = path.indexOf('?');
  return {
    method,
    path,
    basePath: q === -1 ? path : path.slice(0, q),
    query: q === -1 ? '' : path.slice(q + 1),
    headers
  };
}

/** The RFC 6455 Sec-WebSocket-Accept value for a given Sec-WebSocket-Key. */
function getAcceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function sendHttpResponse(client, status, contentType, body) {
  // byteLength, not .length: the body is written as UTF-8, so a string
  // containing any non-ASCII character (an IDN hostname on the stats page, for
  // instance) is longer in bytes than in JS characters, and declaring the
  // character count truncates the response.
  const headers = `HTTP/1.1 ${status} ${STATUS_TEXT[status] || 'OK'}\r\n` +
                  `Content-Type: ${contentType}\r\n` +
                  `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                  `Connection: close\r\n` +
                  `Cache-Control: no-cache, no-store, must-revalidate\r\n` +
                  `\r\n`;
  try {
    client.write(headers + body);
  } catch (e) { /* client already gone */ }
}

function sendRedirect(client, location) {
  const body = '<html><body>Redirecting...</body></html>';
  const headers = `HTTP/1.1 302 Found\r\n` +
                  `Location: ${location}\r\n` +
                  `Content-Type: text/html\r\n` +
                  `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                  `Connection: close\r\n` +
                  `\r\n`;
  try {
    client.write(headers + body);
  } catch (e) { /* client already gone */ }
}

/** The 101 response that completes a WebSocket handshake. */
function writeUpgradeResponse(client, key) {
  client.write(
    `HTTP/1.1 101 Switching Protocols\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Accept: ${getAcceptKey(key)}\r\n\r\n`
  );
}

// ==========================================
// Server-Sent Events
//
// The only response shape here that leaves the socket open. Everything above
// writes a Content-Length body and the caller then tears the connection down;
// these functions open a stream the caller keeps writing to.
// ==========================================

function safeWrite(client, text) {
  try {
    return client.write(text);
  } catch (e) {
    return false;   // client already gone
  }
}

/**
 * Write one HTTP/1.1 chunk.
 *
 * byteLength, not .length: the chunk size prefix counts BYTES. JSON.stringify
 * does not escape non-ASCII, so a single IDN hostname in a snapshot puts raw
 * multibyte UTF-8 in the payload — and a size counting JS characters
 * desynchronises the chunk stream permanently. The browser then stops applying
 * updates with no error raised anywhere. Same trap as Content-Length above.
 */
function writeChunk(client, text) {
  const bytes = Buffer.byteLength(text);
  if (bytes === 0) return true;
  return safeWrite(client, `${bytes.toString(16)}\r\n${text}\r\n`);
}

/**
 * Open a chunked text/event-stream response. Leaves the socket OPEN.
 *
 * Chunked rather than close-delimited on purpose: a body with neither
 * Content-Length nor Transfer-Encoding is legal and EventSource accepts it, but
 * it is close-delimited — and a proxy that cannot see a body boundary is
 * exactly the proxy that buffers until close, silently turning the stream into
 * "nothing ever arrives". Chunked gives every intermediary a per-event flush
 * boundary. X-Accel-Buffering additionally opts out of nginx's proxy_buffering,
 * which is on by default and withholds a proxied response regardless of framing.
 */
function sendEventStreamHead(client) {
  return safeWrite(client,
    `HTTP/1.1 200 OK\r\n` +
    `Content-Type: text/event-stream; charset=utf-8\r\n` +
    `Cache-Control: no-cache, no-store, must-revalidate\r\n` +
    `Connection: keep-alive\r\n` +
    `Transfer-Encoding: chunked\r\n` +
    `X-Accel-Buffering: no\r\n` +
    `\r\n`);
}

/** Tell the browser how long to wait before reconnecting a dropped stream. */
function sendSseRetry(client, ms) {
  return writeChunk(client, `retry: ${ms}\n\n`);
}

/** A comment line. Ignored by EventSource; useful as a keepalive. */
function sendSseComment(client, text) {
  return writeChunk(client, `: ${text}\n\n`);
}

/**
 * Send one event. Multi-line data needs one `data:` line per line, so split
 * defensively even though JSON.stringify escapes control characters.
 */
function sendSseEvent(client, data) {
  const body = String(data).split('\n').map((line) => `data: ${line}\n`).join('');
  return writeChunk(client, `${body}\n`);
}

/** The terminating zero-length chunk. */
function endEventStream(client) {
  return safeWrite(client, '0\r\n\r\n');
}

module.exports = {
  CRLFCRLF,
  indexOfHeaderEnd,
  parseRequestHead,
  getAcceptKey,
  sendHttpResponse,
  sendRedirect,
  writeUpgradeResponse,
  sendEventStreamHead,
  sendSseRetry,
  sendSseComment,
  sendSseEvent,
  endEventStream
};
