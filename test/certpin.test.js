'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tls = require('tls');
const crypto = require('crypto');
const { X509Certificate } = require('crypto');

const { fetchCertInfo, fetchCertPin, createPinCache } = require('../src/node/certpin.js');

// A throwaway self-signed cert/key (RSA-2048, CN=pin-test) for the in-process
// TLS server to present. It only ever serves loopback in this test.
const { CERT_PEM, KEY_PEM } = require('./fixtures/pin-cert.js');

// The expected pin, computed independently of certpin.js: SHA-256 of the DER,
// which is exactly what Xray's pinnedPeerCertSha256 (and Chrome) show.
const EXPECTED = crypto
  .createHash('sha256')
  .update(new X509Certificate(CERT_PEM).raw)
  .digest('hex');

function withServer(fn) {
  return new Promise((resolvePromise, reject) => {
    const server = tls.createServer({ cert: CERT_PEM, key: KEY_PEM }, (socket) => socket.end());
    server.on('error', reject);
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      try {
        await fn(port);
        resolvePromise();
      } catch (e) {
        reject(e);
      } finally {
        server.close();
      }
    });
  });
}

test('fetchCertPin returns the served leaf cert fingerprint as 64 lowercase hex', async () => {
  await withServer(async (port) => {
    const pin = await fetchCertPin('127.0.0.1', 'anything.example', { port });
    assert.match(pin, /^[0-9a-f]{64}$/);
    assert.equal(pin, EXPECTED, 'matches an independent DER SHA-256');
  });
});

test('fetchCertInfo returns the pin plus a cert description', async () => {
  await withServer(async (port) => {
    const info = await fetchCertInfo('127.0.0.1', 'anything.example', { port });
    assert.equal(info.pin, EXPECTED);
    assert.equal(info.subject, 'pin-test', 'subject CN');
    assert.equal(info.issuer, 'pin-test', 'self-signed: issuer CN == subject CN');
    assert.ok(info.validTo && info.validTo !== '?', 'carries an expiry');
  });
});

test('fetchCertPin fingerprints whatever is served regardless of the SNI sent', async () => {
  // A spoofed SNI still yields the server's cert — the whole basis of fronting.
  await withServer(async (port) => {
    const a = await fetchCertPin('127.0.0.1', 'chatgpt.com', { port });
    const b = await fetchCertPin('127.0.0.1', 'www.microsoft.com', { port });
    assert.equal(a, EXPECTED);
    assert.equal(b, EXPECTED);
  });
});

test('fetchCertPin rejects on an unreachable port within the timeout', async () => {
  // Port 1 on loopback: connection refused, fast and deterministic.
  await assert.rejects(
    () => fetchCertPin('127.0.0.1', 'x', { port: 1, timeoutMs: 1000 })
  );
});

test('createPinCache serves the probed pin and caches it', async () => {
  await withServer(async (port) => {
    const cache = createPinCache({ host: '127.0.0.1', servername: 'chatgpt.com', port });
    assert.equal(await cache.get(), EXPECTED);
    assert.equal(await cache.get(), EXPECTED, 'second read is cached');
    cache.stop();
  });
});

test('createPinCache.get() returns null when the edge is unreachable', async () => {
  const cache = createPinCache({ host: '127.0.0.1', servername: 'x', port: 1, timeoutMs: 1000 });
  assert.equal(await cache.get(), null);
  cache.stop();
});
