'use strict';

// The format contract across the two runtime decrypters.
//
// Encryption lives only in the Node tool (node:crypto). It is decrypted by the
// Node runtime (node:crypto, sync, src/node/secrets.js) AND by the Worker/Deno
// runtimes (Web Crypto, async). If those two ever disagree about the byte
// layout — IV size, tag placement, key import — a deployment silently serves
// the decoy. This test pins all three against the same ciphertext.

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('crypto');

let ce;         // the tool (encrypt + its own decrypt)
let nodeSecrets; // the Node runtime decrypt

test.before(async () => {
  ce = await import('../tools/credsecrets.mjs');
  nodeSecrets = require('../src/node/secrets.js');
});

// A standalone Web Crypto decrypt matching what src/worker/secrets.mjs does, so
// this test proves the format without importing the Worker module (which pulls
// in the whole worker graph). The subtle steps are identical.
async function webDecrypt(keyB64, enc) {
  const key = await webcrypto.subtle.importKey(
    'raw', Buffer.from(keyB64, 'base64'), { name: 'AES-GCM' }, false, ['decrypt']
  );
  const iv = Buffer.from(enc.iv, 'base64');
  const data = Buffer.from(enc.ct, 'base64');   // ciphertext || 16-byte tag
  const plain = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return Buffer.from(plain).toString('utf8');
}

const SAMPLES = [
  'a'.repeat(64),                                   // a hex secret
  '00000000-0000-4000-8000-000000000001',           // a UUID
  '/some/ws-path-with-hex-0123456789abcdef',         // a wspath
  'alice bob carol',                                 // user labels
  '',                                                // empty string edge case
  'ünîcodë · 🔐 · multi-byte'                        // non-ASCII
];

test('tool-encrypted values decrypt identically under node:crypto and Web Crypto', async () => {
  const keyB64 = ce.generateKeys().common;
  const key = Buffer.from(keyB64, 'base64');

  for (const sample of SAMPLES) {
    const enc = ce.encryptValue(key, sample);

    // 1) the tool's own decrypt
    assert.equal(ce.decryptValue(key, enc), sample, 'tool decrypt');
    // 2) the Node runtime decrypt (sync node:crypto)
    assert.equal(nodeSecrets.decryptValue(key, enc), sample, 'node runtime decrypt');
    // 3) the Worker/Deno decrypt (async Web Crypto)
    assert.equal(await webDecrypt(keyB64, enc), sample, 'web crypto decrypt');
  }
});

test('the IV is 12 bytes and the tag is appended (16 bytes over the plaintext length)', () => {
  const key = Buffer.from(ce.generateKeys().common, 'base64');
  const plain = 'hello';
  const enc = ce.encryptValue(key, plain);
  assert.equal(Buffer.from(enc.iv, 'base64').length, 12, 'GCM nonce is 12 bytes');
  assert.equal(Buffer.from(enc.ct, 'base64').length, Buffer.byteLength(plain) + 16, 'ct = plaintext + 16-byte tag');
});

test('every value gets a fresh IV', () => {
  const key = Buffer.from(ce.generateKeys().common, 'base64');
  const a = ce.encryptValue(key, 'same');
  const b = ce.encryptValue(key, 'same');
  assert.notEqual(a.iv, b.iv, 'nonces must not repeat under one key');
  assert.notEqual(a.ct, b.ct, 'so identical plaintext encrypts differently');
});

test('a runtime decrypt with the wrong key is rejected, not garbage', async () => {
  const key = Buffer.from(ce.generateKeys().common, 'base64');
  const enc = ce.encryptValue(key, 'secret');
  const wrongB64 = ce.generateKeys().common;
  const wrong = Buffer.from(wrongB64, 'base64');

  assert.throws(() => nodeSecrets.decryptValue(wrong, enc), /auth|decrypt/i);
  await assert.rejects(webDecrypt(wrongB64, enc), 'web crypto rejects a wrong key');
});
