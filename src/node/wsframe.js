'use strict';

// WebSocket wire framing (RFC 6455), server side.
//
// Pure functions, no per-connection state: the previous createWsCodec()
// closure captured nothing — every call already allocated a fresh output
// buffer — so there was nothing for a factory to own.
//
// Inputs may be Buffer or plain Uint8Array (bytes come from a ByteQueue, see
// src/vless.js), so writes into output buffers use `.set()` rather than
// Buffer#copy, which exists only on Buffer.

const OPCODE = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa
};

/**
 * Decode one frame from the front of `buffer`.
 *
 * Returns null when more bytes are needed, otherwise
 * { fin, opcode, payload, consumed }.
 */
function decodeFrame(buffer) {
  const blen = buffer.length;
  if (blen < 2) return null;

  const b1 = buffer[0];
  const b2 = buffer[1];
  const fin = (b1 >>> 7) === 1;
  const opcode = b1 & 0x0f;
  const masked = (b2 >>> 7) === 1;
  let payloadLen = b2 & 0x7f;

  let headerLen = 2;
  if (payloadLen === 126) {
    if (blen < 4) return null;
    payloadLen = (buffer[2] << 8) | buffer[3];
    headerLen = 4;
  } else if (payloadLen === 127) {
    if (blen < 10) return null;
    // Multiply rather than shift for the high byte: JS bitwise operators work
    // on 32-bit SIGNED integers, so `buffer[6] << 24` would go negative on
    // frames over 2 GiB and produce a negative length.
    payloadLen = (buffer[6] * 16777216) + (buffer[7] << 16) + (buffer[8] << 8) + buffer[9];
    headerLen = 10;
  }

  let mask;
  if (masked) {
    if (blen < headerLen + 4) return null;
    mask = buffer.subarray(headerLen, headerLen + 4);
    headerLen += 4;
  }

  if (blen < headerLen + payloadLen) return null;

  let payload;
  if (masked && payloadLen > 0) {
    // Unmasking must not write back into the source: the caller's queue may
    // still hold these bytes, and an in-place XOR would corrupt them.
    payload = Buffer.allocUnsafe(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buffer[headerLen + i] ^ mask[i & 3];
    }
  } else {
    payload = buffer.subarray(headerLen, headerLen + payloadLen);
  }

  return { fin, opcode, payload, consumed: headerLen + payloadLen };
}

/** Bytes needed for a server-side (unmasked) frame header of `plen` payload. */
function headerLengthFor(plen) {
  if (plen > 65535) return 10;
  if (plen > 125) return 4;
  return 2;
}

/** Write the FIN+opcode and length prefix into `out`; returns the offset after it. */
function writeHeader(out, opcode, plen) {
  out[0] = 0x80 | (opcode & 0x0f);
  if (plen <= 125) {
    out[1] = plen;
    return 2;
  }
  if (plen <= 65535) {
    out[1] = 126;
    out[2] = plen >>> 8;
    out[3] = plen & 0xff;
    return 4;
  }
  out[1] = 127;
  out[2] = 0; out[3] = 0; out[4] = 0; out[5] = 0;
  out[6] = (plen >>> 24) & 0xff;
  out[7] = (plen >>> 16) & 0xff;
  out[8] = (plen >>> 8) & 0xff;
  out[9] = plen & 0xff;
  return 10;
}

/** Encode a single unfragmented frame. */
function encodeFrame(opcode, payload) {
  const plen = payload.length;
  const out = Buffer.allocUnsafe(headerLengthFor(plen) + plen);
  const offset = writeHeader(out, opcode, plen);
  if (plen > 0) out.set(payload, offset);
  return out;
}

/**
 * Encode a Mux.Cool frame and its enclosing WebSocket frame in one allocation.
 *
 * Mux payload layout: u16 metaLen, meta, then (if hasData) u16 dataLen, data.
 */
function encodeMuxFrame(opcode, meta, hasData, payload) {
  const metaLen = meta.length;
  const dataLen = hasData ? payload.length : 0;
  const plen = 2 + metaLen + (hasData ? 2 + dataLen : 0);

  const out = Buffer.allocUnsafe(headerLengthFor(plen) + plen);
  let offset = writeHeader(out, opcode, plen);

  out[offset++] = (metaLen >>> 8) & 0xff;
  out[offset++] = metaLen & 0xff;
  if (metaLen > 0) {
    out.set(meta, offset);
    offset += metaLen;
  }

  if (hasData) {
    out[offset++] = (dataLen >>> 8) & 0xff;
    out[offset++] = dataLen & 0xff;
    if (dataLen > 0) out.set(payload, offset);
  }

  return out;
}

module.exports = { OPCODE, decodeFrame, encodeFrame, encodeMuxFrame };
