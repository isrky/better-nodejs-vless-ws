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

module.exports = { startTestServer, rawRequest, rawTlsRequest, splitResponse, get };
