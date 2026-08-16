'use strict';

// Environment-derived configuration for the Node build.
//
// This is the ONLY module under src/ allowed to read process.env — everything
// else takes a config object. That keeps the server constructible with
// arbitrary settings from a test without mutating global state.
// Mirrors src/worker/config.mjs, which does the same job for the Worker build.

const vless = require('../vless.js');

const { uuidToBytes } = vless;

// Insecure on purpose-of-record: it is published in this repo, so anyone can
// use it. Production deployments MUST override UUID via the environment.
const DEFAULT_UUID = '7bd180e8-1142-4387-93f5-03e8d750a896';
const DEFAULT_WSPATH = '/';

// Cap on how many bytes of request head will be buffered before a client is
// dropped. A client that connects and never sends \r\n\r\n would otherwise
// grow the queue without limit.
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024;

/**
 * Read configuration out of `env` (defaults to process.env) and freeze it.
 *
 * SERVER_PORT/SERVER_HOST take precedence over PORT/HOST so the server can run
 * on a platform that injects its own PORT while still being pinned explicitly.
 */
function loadConfig(env = process.env) {
  const uuid = env.UUID || DEFAULT_UUID;

  return Object.freeze({
    uuid,
    uuidBytes: uuidToBytes(uuid),
    wsPath: env.WSPATH || DEFAULT_WSPATH,
    // The /admin-stats dashboard exposes wsPath and traffic stats. Behind a
    // path-scoped reverse proxy it was unreachable, but a platform that
    // forwards every path (e.g. Fly) makes it world-readable. Gate it: unset
    // => hidden (served the decoy page); set => requires ?token=<ADMIN_TOKEN>.
    adminToken: env.ADMIN_TOKEN || '',
    port: parseInt(env.SERVER_PORT || env.PORT || '3000', 10),
    host: env.SERVER_HOST || env.HOST || '0.0.0.0',
    dnsTtl: 300,
    dnsSweep: 60,
    maxHeaderBytes: DEFAULT_MAX_HEADER_BYTES
  });
}

module.exports = {
  loadConfig,
  DEFAULT_UUID,
  DEFAULT_WSPATH,
  DEFAULT_MAX_HEADER_BYTES
};
