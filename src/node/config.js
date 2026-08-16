'use strict';

// Environment-derived configuration for the Node build.
//
// This is the ONLY module under src/ allowed to read process.env — everything
// else takes a config object. That keeps the server constructible with
// arbitrary settings from a test without mutating global state.
// Mirrors src/worker/config.mjs, which does the same job for the Worker build.

const vless = require('../vless.js');
const { createUserRegistry, parseUserLabels } = require('./users.js');
const { subkey } = require('./tokens.js');

const { uuidToBytes } = vless;

// Insecure on purpose-of-record: it is published in this repo, so anyone can
// use it. Production deployments MUST override UUID via the environment.
const DEFAULT_UUID = '7bd180e8-1142-4387-93f5-03e8d750a896';
const DEFAULT_WSPATH = '/';

// Cap on how many bytes of request head will be buffered before a client is
// dropped. A client that connects and never sends \r\n\r\n would otherwise
// grow the queue without limit.
const DEFAULT_MAX_HEADER_BYTES = 16 * 1024;

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Force a leading and trailing slash so prefix matching cannot half-match. */
function normalisePrefix(raw) {
  let path = String(raw || '/i/').trim();
  if (!path.startsWith('/')) path = '/' + path;
  if (!path.endsWith('/')) path += '/';
  return path;
}

/**
 * Read configuration out of `env` (defaults to process.env) and freeze it.
 *
 * SERVER_PORT/SERVER_HOST take precedence over PORT/HOST so the server can run
 * on a platform that injects its own PORT while still being pinned explicitly.
 */
function loadConfig(env = process.env) {
  const uuid = env.UUID || DEFAULT_UUID;

  // Provisioned users are derived from a secret rather than stored, because Fly
  // has no volume and its filesystem does not survive a deploy. Both secrets are
  // accepted so a rotation can be done in two deploys instead of locking every
  // provisioned device out at once.
  const secrets = [env.PROVISION_SECRET, env.PROVISION_SECRET_PREVIOUS]
    .filter((s) => typeof s === 'string' && s.length > 0);

  const { labels, rejected } = parseUserLabels(env.USERS);
  const registry = createUserRegistry({ secrets, labels, legacyUuid: uuid });

  const adminToken = env.ADMIN_TOKEN || '';

  return Object.freeze({
    uuid,
    uuidBytes: uuidToBytes(uuid),
    registry,
    // Labels that failed validation, so the server can warn about them at boot
    // rather than throwing and turning one typo into a crash-loop.
    rejectedLabels: Object.freeze(rejected),
    provisioning: registry.provisioning,
    // Signing keys. Sessions fall back to ADMIN_TOKEN so cookie auth works
    // without provisioning configured; changing ADMIN_TOKEN then invalidates
    // every live session, which is the behaviour you want.
    sessionKey: subkey(env.PROVISION_SECRET || adminToken || DEFAULT_UUID, 'adm-session-v1'),
    inviteKey: subkey(env.PROVISION_SECRET || '', 'invite-key-v1'),
    inviteTtl: clamp(parseInt(env.INVITE_TTL_SECONDS || '900', 10), 60, 86400),
    invitePath: normalisePrefix(env.INVITE_PATH || '/i/'),
    sessionTtl: clamp(parseInt(env.SESSION_TTL_SECONDS || '43200', 10), 60, 604800),
    publicHost: String(env.PUBLIC_HOST || '').trim().toLowerCase(),
    publicPort: parseInt(env.PUBLIC_PORT || '443', 10),
    interceptCa: String(env.INTERCEPT_CA || ''),
    // Fly terminates TLS upstream, so X-Forwarded-Proto and Fly-Client-IP are
    // only trustworthy when we know we are behind that proxy.
    trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY === '1' : Boolean(env.FLY_APP_NAME),
    wsPath: env.WSPATH || DEFAULT_WSPATH,
    // The /admin-stats dashboard exposes wsPath and traffic stats. Behind a
    // path-scoped reverse proxy it was unreachable, but a platform that
    // forwards every path (e.g. Fly) makes it world-readable. Gate it: unset
    // => hidden (served the decoy page); set => requires ?token=<ADMIN_TOKEN>.
    adminToken,
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
