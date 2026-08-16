'use strict';

// The set of credentials the server will accept.
//
// UUIDs are DERIVED, never stored: uuid(label) = HMAC-SHA256(secret, tag+label)
// truncated to 16 bytes. That is what makes provisioning work on Fly, which has
// no volume and whose filesystem is destroyed on every deploy, restart, OOM and
// host migration. The whole registry is reproducible from two Fly secrets, so
// there is nothing to lose.
//
// Revocation = drop the label from USERS and redeploy.

const { createHmac } = require('crypto');

const { uuidToBytes } = require('../vless.js');

// Domain separator. Note the trailing newline: it is what makes
// `UUID_TAG + label` unambiguous, and it only works because a valid label can
// never contain a newline. Loosening LABEL_RE silently breaks that property.
const UUID_TAG = 'vless-uuid-v1\n';

// Labels land in HTML text and attributes, in a Content-Disposition filename,
// and in the fragment of a vless:// URI. This charset makes all three safe by
// construction; the escaping applied at each site is defence in depth.
const LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_LABEL_LEN = 32;

// Bounds the per-user stats map and the registry itself on a 256 MB machine.
const MAX_USERS = 64;

// The operator's own credential, from UUID. Reserved so the invite flow can
// never hand out the identity every one of the operator's devices already uses.
const LEGACY_LABEL = 'owner';

function isValidLabel(label) {
  return typeof label === 'string' && LABEL_RE.test(label);
}

/** Render 16 bytes as a canonical UUID string. */
function formatUuid(bytes) {
  let hex = '';
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Derive one user's credential.
 *
 * The version/variant bits do not matter to VLESS — the wire carries 16 opaque
 * bytes — but they keep strict importers happy and stop Xray treating a
 * non-canonical `id` as something to MD5-derive from.
 */
function deriveUser(secret, label) {
  const mac = createHmac('sha256', String(secret)).update(UUID_TAG + label, 'utf8').digest();
  const bytes = Uint8Array.from(mac.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;   // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80;   // RFC 4122 variant
  return Object.freeze({ label, bytes, uuid: formatUuid(bytes) });
}

/**
 * Parse the USERS env value. Accepts commas, semicolons and whitespace.
 *
 * Invalid entries are REPORTED, never thrown: loadConfig throws exactly once
 * today (a malformed UUID), and a throw on a typo'd USERS value would turn one
 * bad character into a Fly crash-loop.
 */
function parseUserLabels(raw) {
  const labels = [];
  const rejected = [];
  const seen = new Set();

  for (const token of String(raw || '').split(/[\s,;]+/)) {
    if (!token) continue;

    // Fold case before validating, so Alice and alice cannot become two people.
    const label = token.toLowerCase();

    if (!isValidLabel(label) || label === LEGACY_LABEL) {
      rejected.push(token);
      continue;
    }
    if (seen.has(label)) continue;
    if (labels.length >= MAX_USERS) {
      rejected.push(token);
      continue;
    }

    seen.add(label);
    labels.push(label);
  }

  return { labels, rejected };
}

/** First four bytes as an unsigned 32-bit bucket key. */
function bucketKey(payload, off) {
  return ((payload[off] << 24) | (payload[off + 1] << 16) |
          (payload[off + 2] << 8) | payload[off + 3]) >>> 0;
}

function matches(user, payload, off) {
  const bytes = user.bytes;
  for (let i = 0; i < 16; i++) {
    if (payload[off + i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * Build the registry.
 *
 * `secrets` is an ARRAY so a secret rotation does not lock everyone out at
 * once: every label is derived under every secret and all derivations are
 * accepted, while byLabel() returns only the current-secret user so new invites
 * mint the new credential. Rotation is then a two-deploy operation instead of a
 * silent, unrecoverable outage for every provisioned device.
 */
function createUserRegistry({ secrets = [], labels = [], legacyUuid = null } = {}) {
  const buckets = new Map();
  const current = new Map();

  function add(user) {
    const key = bucketKey(user.bytes, 0);
    const hit = buckets.get(key);
    if (hit === undefined) buckets.set(key, user);
    else if (Array.isArray(hit)) hit.push(user);
    else buckets.set(key, [hit, user]);
  }

  if (legacyUuid) {
    const owner = Object.freeze({
      label: LEGACY_LABEL,
      bytes: uuidToBytes(legacyUuid),
      uuid: legacyUuid
    });
    current.set(LEGACY_LABEL, owner);
    add(owner);
  }

  const usable = secrets.filter((s) => typeof s === 'string' && s.length > 0);
  for (const label of labels) {
    usable.forEach((secret, index) => {
      const user = deriveUser(secret, label);
      // secrets[0] is the current one; later entries are accepted but never minted.
      if (index === 0) current.set(label, user);
      add(user);
    });
  }

  const frozenLabels = Object.freeze(labels.slice());

  return {
    get size() {
      return current.size;
    },

    labels: frozenLabels,

    provisioning: usable.length > 0,

    /** Hot path: one Map hit plus 16 byte comparisons. No allocation. */
    lookup(payload, off) {
      const hit = buckets.get(bucketKey(payload, off));
      if (hit === undefined) return null;
      if (!Array.isArray(hit)) return matches(hit, payload, off) ? hit : null;
      for (let i = 0; i < hit.length; i++) {
        if (matches(hit[i], payload, off)) return hit[i];
      }
      return null;
    },

    /**
     * The credential an invite may hand out.
     *
     * Deliberately NOT a general byLabel(): the owner entry is in the registry
     * so the operator's existing devices authenticate, but it must never be
     * mintable, or the invite flow would hand a guest the identity every one of
     * the operator's own devices uses — unrevokable without rotating UUID.
     */
    mintable(label) {
      if (label === LEGACY_LABEL) return null;
      return current.get(label) || null;
    },

    /**
     * Labels only — deliberately never UUIDs. The admin page needs names, and
     * a credential is materialised only on the invite path, which is the
     * structural reason no derived UUID can leak into a rendered page.
     */
    list() {
      return frozenLabels.map((label) => ({ label }));
    }
  };
}

module.exports = {
  createUserRegistry,
  deriveUser,
  parseUserLabels,
  isValidLabel,
  formatUuid,
  LABEL_RE,
  MAX_LABEL_LEN,
  MAX_USERS,
  LEGACY_LABEL,
  UUID_TAG
};
