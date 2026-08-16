'use strict';

// Guards the WebSocket codec across the Buffer -> Uint8Array migration.
// encodeFrame/encodeMuxFrame switched from Buffer#copy to TypedArray#set;
// `.copy` does not exist on a Uint8Array, so these round-trips are the direct
// check that the change is correct for BOTH input flavours.

const test = require('node:test');
const assert = require('node:assert/strict');

const { OPCODE, decodeFrame, encodeFrame, encodeMuxFrame } = require('../src/node/wsframe.js');

/** Client->server frames are always masked; build one to feed decodeFrame. */
function maskedFrame(opcode, payload, mask = [0x1a, 0x2b, 0x3c, 0x4d]) {
  const plen = payload.length;
  const header = [];
  header.push(0x80 | opcode);
  if (plen <= 125) {
    header.push(0x80 | plen);
  } else if (plen <= 65535) {
    header.push(0x80 | 126, plen >>> 8, plen & 0xff);
  } else {
    header.push(0x80 | 127, 0, 0, 0, 0,
      (plen >>> 24) & 0xff, (plen >>> 16) & 0xff, (plen >>> 8) & 0xff, plen & 0xff);
  }
  header.push(...mask);
  const masked = Buffer.allocUnsafe(plen);
  for (let i = 0; i < plen; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([Buffer.from(header), masked]);
}

const LENGTHS = [0, 1, 125, 126, 127, 65535, 65536];

test('encodeFrame -> decodeFrame round-trips at every length boundary', () => {
  for (const len of LENGTHS) {
    const payload = Buffer.allocUnsafe(len).fill(0xab);
    const encoded = encodeFrame(OPCODE.BINARY, payload);
    const decoded = decodeFrame(encoded);

    assert.ok(decoded, `len ${len}: expected a frame`);
    assert.equal(decoded.fin, true, `len ${len}: fin`);
    assert.equal(decoded.opcode, OPCODE.BINARY, `len ${len}: opcode`);
    assert.equal(decoded.consumed, encoded.length, `len ${len}: consumed`);
    assert.deepEqual(Buffer.from(decoded.payload), payload, `len ${len}: payload`);
  }
});

test('encodeFrame accepts a plain Uint8Array payload (the .copy -> .set change)', () => {
  // A Uint8Array has no .copy(); before the change this threw a TypeError.
  const payload = Uint8Array.from([1, 2, 3, 4, 5]);
  const decoded = decodeFrame(encodeFrame(OPCODE.PONG, payload));
  assert.equal(decoded.opcode, OPCODE.PONG);
  assert.deepEqual(Buffer.from(decoded.payload), Buffer.from(payload));
});

test('encodeFrame picks the minimal header length', () => {
  assert.equal(encodeFrame(OPCODE.BINARY, Buffer.alloc(125)).length, 2 + 125);
  assert.equal(encodeFrame(OPCODE.BINARY, Buffer.alloc(126)).length, 4 + 126);
  assert.equal(encodeFrame(OPCODE.BINARY, Buffer.alloc(65535)).length, 4 + 65535);
  assert.equal(encodeFrame(OPCODE.BINARY, Buffer.alloc(65536)).length, 10 + 65536);
});

test('decodeFrame unmasks without mutating the source buffer', () => {
  const payload = Buffer.from('hello websocket');
  const frame = maskedFrame(OPCODE.TEXT, payload);
  const copy = Buffer.from(frame);

  const decoded = decodeFrame(frame);
  assert.deepEqual(Buffer.from(decoded.payload), payload);
  assert.deepEqual(frame, copy, 'source frame must be untouched');
});

test('decodeFrame returns null at every truncation point', () => {
  const frame = maskedFrame(OPCODE.BINARY, Buffer.alloc(300).fill(7));
  for (let cut = 0; cut < frame.length; cut++) {
    assert.equal(decodeFrame(frame.subarray(0, cut)), null, `truncated to ${cut}`);
  }
  assert.ok(decodeFrame(frame), 'full frame decodes');
});

test('the 64-bit length path stays non-negative above 2 GiB', () => {
  // Header only — asserting the length arithmetic, not allocating 3 GiB.
  const header = Buffer.from([
    0x82, 127,
    0x00, 0x00, 0x00, 0x00,   // high 32 bits, always zero here
    0xc0, 0x00, 0x00, 0x00    // 0xc0000000 = 3 GiB, negative if shifted signed
  ]);
  // Not enough payload, so it returns null — but it must have computed a
  // positive length to get there rather than a negative one.
  assert.equal(decodeFrame(header), null);

  const len = (header[6] * 16777216) + (header[7] << 16) + (header[8] << 8) + header[9];
  assert.equal(len, 0xc0000000);
  assert.ok(len > 0, 'length must not overflow to negative');
});

test('decodeFrame reports consumed so a stream of frames can be walked', () => {
  const a = encodeFrame(OPCODE.BINARY, Buffer.from('first'));
  const b = encodeFrame(OPCODE.BINARY, Buffer.from('second'));
  const stream = Buffer.concat([a, b]);

  const one = decodeFrame(stream);
  assert.deepEqual(Buffer.from(one.payload), Buffer.from('first'));

  const two = decodeFrame(stream.subarray(one.consumed));
  assert.deepEqual(Buffer.from(two.payload), Buffer.from('second'));
  assert.equal(one.consumed + two.consumed, stream.length);
});

test('encodeMuxFrame lays out metaLen/meta/dataLen/data big-endian', () => {
  const meta = Buffer.from([0x00, 0x07, 0x02, 0x01]);
  const data = Buffer.from('payload');

  const frame = encodeMuxFrame(OPCODE.BINARY, meta, true, data);
  const decoded = decodeFrame(frame);
  const p = Buffer.from(decoded.payload);

  assert.equal((p[0] << 8) | p[1], meta.length, 'metaLen');
  assert.deepEqual(p.subarray(2, 2 + meta.length), meta, 'meta');

  const off = 2 + meta.length;
  assert.equal((p[off] << 8) | p[off + 1], data.length, 'dataLen');
  assert.deepEqual(p.subarray(off + 2), data, 'data');
  assert.equal(p.length, 2 + meta.length + 2 + data.length);
});

test('encodeMuxFrame omits the data section when hasData is false', () => {
  const meta = Buffer.from([0x00, 0x07, 0x03, 0x00]);
  const p = Buffer.from(decodeFrame(encodeMuxFrame(OPCODE.BINARY, meta, false, Buffer.alloc(0))).payload);

  assert.equal(p.length, 2 + meta.length, 'no dataLen prefix when hasData is false');
  assert.equal((p[0] << 8) | p[1], meta.length);
});

test('encodeMuxFrame accepts Uint8Array meta and data', () => {
  const meta = Uint8Array.from([0, 9, 2, 1]);
  const data = Uint8Array.from([9, 8, 7]);
  const p = Buffer.from(decodeFrame(encodeMuxFrame(OPCODE.BINARY, meta, true, data)).payload);
  assert.deepEqual(p.subarray(2, 6), Buffer.from(meta));
  assert.deepEqual(p.subarray(8), Buffer.from(data));
});
