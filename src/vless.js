'use strict';

// Runtime-agnostic VLESS protocol helpers.
//
// Nothing here touches net/dgram/Buffer, so the same code runs under Node
// (where Buffer is a Uint8Array subclass) and on Cloudflare Workers.
// CommonJS on purpose: appws.js requires it directly, and wrangler's bundler
// pulls it into the ESM worker via a default import.

const DEC = new TextDecoder();

const BLOCKED_DOMAINS = [
  'speedtest.net', 'fast.com', 'speedtest.cn', 'speed.cloudflare.com', 'speedof.me',
  'testmy.net', 'bandwidth.place', 'speed.io', 'librespeed.org', 'speedcheck.org'
];

const BLOCKED_SET = new Set(BLOCKED_DOMAINS);

function isBlockedDomain(host) {
  if (!host) return false;
  const hl = host.toLowerCase();
  if (BLOCKED_SET.has(hl)) return true;
  for (let i = 0; i < BLOCKED_DOMAINS.length; i++) {
    if (hl.endsWith('.' + BLOCKED_DOMAINS[i])) return true;
  }
  return false;
}

/** Parse a canonical or bare-hex UUID into its 16 bytes. */
function uuidToBytes(uuid) {
  const hex = String(uuid).replace(/-/g, '').trim();
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error('Invalid UUID: ' + uuid);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** The VLESS reply that precedes the first byte of response payload. */
const VLESS_OK_HEADER = new Uint8Array([0x00, 0x00]);

const NEED = { status: 'need' };

function fail(reason) {
  return { status: 'fail', reason };
}

/**
 * Parse a VLESS request header.
 *
 * Returns {status:'need'} when more bytes are required, {status:'fail',reason}
 * when the request must be rejected, or {status:'ok', cmd, host, port,
 * headerEnd} on success. `headerEnd` is the offset where payload begins.
 *
 * cmd 1 = TCP, 2 = UDP, 3 = Mux.Cool (which carries no address of its own).
 */
function parseVlessHeader(payload, uuidBytes) {
  if (payload.length < 18) return NEED;
  if (payload[0] !== 0) return fail('Bad Version');

  for (let i = 0; i < 16; i++) {
    if (payload[1 + i] !== uuidBytes[i]) return fail('UUID Mismatch');
  }

  const optLen = payload[17];
  let pos = 18 + optLen;
  if (payload.length < pos + 1) return NEED;

  const cmd = payload[pos];
  pos += 1;

  // Mux.Cool addresses each substream inside its own frames.
  if (cmd === 3) return { status: 'ok', cmd, host: '0.0.0.0', port: 0, headerEnd: pos };

  if (cmd !== 1 && cmd !== 2) return fail('Unknown Command: ' + cmd);

  if (payload.length < pos + 3) return NEED;
  const port = (payload[pos] << 8) | payload[pos + 1];
  pos += 2;

  const atyp = payload[pos];
  pos += 1;
  let host = '';

  if (atyp === 0x01) {
    if (payload.length < pos + 4) return NEED;
    host = `${payload[pos]}.${payload[pos + 1]}.${payload[pos + 2]}.${payload[pos + 3]}`;
    pos += 4;
  } else if (atyp === 0x02) {
    if (payload.length < pos + 1) return NEED;
    const hlen = payload[pos];
    pos += 1;
    if (payload.length < pos + hlen) return NEED;
    host = DEC.decode(payload.subarray(pos, pos + hlen));
    pos += hlen;
  } else if (atyp === 0x03) {
    if (payload.length < pos + 16) return NEED;
    const parts = [];
    for (let j = 0; j < 8; j++) {
      parts.push(((payload[pos + j * 2] << 8) | payload[pos + j * 2 + 1]).toString(16));
    }
    host = parts.join(':');
    pos += 16;
  } else if (atyp === 0x00) {
    host = '0.0.0.0';
  } else {
    return fail('Unknown ATYP: ' + atyp);
  }

  if (isBlockedDomain(host)) return fail('Blocked Domain: ' + host);

  return { status: 'ok', cmd, host, port, headerEnd: pos };
}

/**
 * Parse an address out of a Mux.Cool meta block starting at `off`
 * (network/port/atyp/addr). Returns {host, end} or null if truncated.
 */
function parseMuxAddress(meta, off) {
  if (meta.length < off + 1) return null;
  const atyp = meta[off];
  let pos = off + 1;

  if (atyp === 1) {
    if (meta.length < pos + 4) return null;
    return { host: `${meta[pos]}.${meta[pos + 1]}.${meta[pos + 2]}.${meta[pos + 3]}`, end: pos + 4 };
  }
  if (atyp === 2) {
    const hlen = meta[pos];
    pos += 1;
    if (!hlen || meta.length < pos + hlen) return null;
    return { host: DEC.decode(meta.subarray(pos, pos + hlen)), end: pos + hlen };
  }
  if (atyp === 3) {
    if (meta.length < pos + 16) return null;
    const parts = [];
    for (let j = 0; j < 8; j++) {
      parts.push(((meta[pos + j * 2] << 8) | meta[pos + j * 2 + 1]).toString(16));
    }
    return { host: parts.join(':'), end: pos + 16 };
  }
  return null;
}

// ==========================================
// Chunked byte queue
//
// Append is cheap; the parts are compacted only when a contiguous view is
// actually needed, and the compacted result is memoized back into the queue.
// ==========================================

const EMPTY = new Uint8Array(0);

class ByteQueue {
  constructor() {
    this.parts = [];
    this.size = 0;
  }

  push(chunk) {
    if (!chunk || chunk.byteLength === 0) return;
    this.parts.push(chunk);
    this.size += chunk.byteLength;
  }

  /**
   * Byte at absolute index i, without merging the parts.
   *
   * Frame parsers only need a handful of header bytes before they know how far
   * to slice, so reading them in place avoids flatten()'s copy of everything
   * still pending — which would otherwise be repaid on every chunk that
   * arrives while a frame is still incomplete.
   */
  at(i) {
    if (i < 0 || i >= this.size) return undefined;
    for (let p = 0; p < this.parts.length; p++) {
      const part = this.parts[p];
      if (i < part.byteLength) return part[i];
      i -= part.byteLength;
    }
    return undefined;
  }

  /** Copy of [start, end), assembled across part boundaries. */
  slice(start, end) {
    if (end === undefined || end > this.size) end = this.size;
    if (start < 0) start = 0;
    if (end <= start) return EMPTY;

    const out = new Uint8Array(end - start);
    let offset = 0;
    let skip = start;
    let remaining = end - start;

    for (let p = 0; p < this.parts.length && remaining > 0; p++) {
      const part = this.parts[p];
      if (skip >= part.byteLength) {
        skip -= part.byteLength;
        continue;
      }
      const take = Math.min(part.byteLength - skip, remaining);
      out.set(part.subarray(skip, skip + take), offset);
      offset += take;
      remaining -= take;
      skip = 0;
    }
    return out;
  }

  /** Contiguous view of everything queued. */
  flatten() {
    if (this.size === 0) return EMPTY;
    if (this.parts.length === 1) return this.parts[0];
    const out = new Uint8Array(this.size);
    let off = 0;
    for (let i = 0; i < this.parts.length; i++) {
      out.set(this.parts[i], off);
      off += this.parts[i].byteLength;
    }
    this.parts = [out];
    return out;
  }

  consume(n) {
    if (n <= 0) return;
    if (n >= this.size) return this.clear();
    let skip = n;
    while (this.parts.length > 0 && skip >= this.parts[0].byteLength) {
      skip -= this.parts[0].byteLength;
      this.parts.shift();
    }
    if (skip > 0 && this.parts.length > 0) {
      this.parts[0] = this.parts[0].subarray(skip);
    }
    this.size -= n;
    if (this.size < 0) this.size = 0;
  }

  clear() {
    this.parts = [];
    this.size = 0;
  }
}

function concat(a, b) {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

module.exports = {
  BLOCKED_DOMAINS,
  ByteQueue,
  VLESS_OK_HEADER,
  concat,
  isBlockedDomain,
  parseMuxAddress,
  parseVlessHeader,
  uuidToBytes
};
