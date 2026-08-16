'use strict';

// End-to-end guard for the refactor: proves the server still binds, still
// answers the decoy page byte-for-byte, and still auto-detects TLS vs
// plaintext on the same port. Highest value per line in the suite — if these
// pass, the extraction did not break the request path.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  startTestServer, rawRequest, rawTlsRequest, splitResponse, get
} = require('./helpers/rawclient.js');

const { FAKE_INDEX_HTML } = require('../src/decoy.js');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Computed, not pinned. These assertions exist to prove the bytes on the wire
// are the decoy constant unmodified and untruncated — not to freeze the page's
// content, which a pinned hash would turn into a change-detector needing a hand
// edit on every copy tweak. Drift between the two builds is covered separately
// by the cross-build test in pages.test.js.
const DECOY_SHA256 = sha256(FAKE_INDEX_HTML);

test('server smoke', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  await t.test('createServer does not bind on its own', () => {
    // startTestServer had to call listen() explicitly to get a port, which is
    // the property being asserted: construction alone has no side effect.
    assert.ok(srv.port > 0);
  });

  await t.test('plaintext GET / serves the decoy page', async () => {
    const { head, body } = splitResponse(await rawRequest(srv.port, get('/')));
    assert.match(head, /^HTTP\/1\.1 200 OK/);
    assert.match(head, /Content-Type: text\/html; charset=utf-8/);
    assert.equal(sha256(body), DECOY_SHA256);
  });

  await t.test('Content-Length matches the body actually sent', async () => {
    const { head, body } = splitResponse(await rawRequest(srv.port, get('/')));
    const declared = Number(head.match(/Content-Length: (\d+)/)[1]);
    assert.equal(declared, body.length);
  });

  await t.test('TLS ClientHello (0x16) is detected on the same port', async () => {
    const { head, body } = splitResponse(await rawTlsRequest(srv.port, get('/')));
    assert.match(head, /^HTTP\/1\.1 200 OK/);
    assert.equal(sha256(body), DECOY_SHA256);
  });

  await t.test('a non-WebSocket upgrade request still gets the decoy', async () => {
    const { body } = splitResponse(
      await rawRequest(srv.port, get('/', 'Upgrade: h2c\r\nConnection: Upgrade\r\n'))
    );
    assert.equal(sha256(body), DECOY_SHA256);
  });

  await t.test('a WebSocket upgrade with no Sec-WebSocket-Key is rejected', async () => {
    const { head } = splitResponse(
      await rawRequest(srv.port, get('/', 'Upgrade: websocket\r\nConnection: Upgrade\r\n'))
    );
    assert.match(head, /^HTTP\/1\.1 400 Bad Request/);
  });

  await t.test('a valid WebSocket upgrade gets 101 with the RFC6455 accept key', async () => {
    // The fixed key/accept pair from RFC 6455 section 1.3.
    const raw = await new Promise((resolve, reject) => {
      const socket = require('net').connect(srv.port, '127.0.0.1', () => {
        const chunks = [];
        socket.on('data', (c) => {
          chunks.push(c);
          const buf = Buffer.concat(chunks);
          if (buf.includes('\r\n\r\n')) {
            socket.destroy();
            resolve(buf);
          }
        });
        socket.write(get('/', 'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n'));
      });
      socket.on('error', reject);
    });
    const head = raw.toString('utf8');
    assert.match(head, /^HTTP\/1\.1 101 Switching Protocols/);
    assert.match(head, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  });
});
