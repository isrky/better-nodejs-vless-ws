'use strict';

// Everything that is signed: admin sessions and provisioning invites.
//
// One master secret produces every key, via HMAC subkeys with distinct tags, so
// a token minted for one purpose can never verify for another. All MACs are
// HMAC-SHA256 truncated to 128 bits, which is far past brute force over a
// network and keeps invite URLs short enough to stay a sparse, scannable QR.
//
// The discipline that matters here: VERIFY THE MAC BEFORE PARSING ANYTHING.
// No Number(), no split(), no registry lookup is reachable from unsigned input.

const { createHmac, timingSafeEqual } = require('crypto');

// Domain separation. Changing any of these invalidates the tokens it covers,
// which is the intended way to force every session or invite to expire at once.
const SESSION_TAG = 'adm-session-v1';
const INVITE_TAG = 'invite-v1';
const SUBKEY_TAG = 'subkey-v1';

// Truncation length for every MAC in this file, in bytes.
const MAC_BYTES = 16;

/** base64url, no padding. */
function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Constant-time string comparison.
 *
 * The length pre-check leaks length — unavoidable, since timingSafeEqual throws
 * on unequal lengths. Harmless for every value here: MACs are a fixed 22 chars.
 */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Admin token comparison. Lives here so session.js and the gate share one impl. */
function tokensMatch(given, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  return constantTimeEqual(given, expected);
}

/**
 * Derive a purpose-specific key from a master secret.
 *
 * Keeps the master out of every signing path, so leaking one subkey does not
 * let an attacker mint tokens of a different kind.
 */
function subkey(master, tag) {
  return createHmac('sha256', String(master)).update(SUBKEY_TAG + '\n' + tag, 'utf8').digest();
}

/** The MAC over `body`, 128 bits as 22 base64url chars. */
function sign(key, tag, body) {
  return b64url(
    createHmac('sha256', key).update(tag + '\n' + body, 'utf8').digest().subarray(0, MAC_BYTES)
  );
}

/** Split a `<body>.<mac>` token at its LAST dot. Returns null if malformed. */
function splitMac(token, maxLen) {
  if (typeof token !== 'string' || token.length < 8 || token.length > maxLen) return null;
  const cut = token.lastIndexOf('.');
  if (cut <= 0 || cut === token.length - 1) return null;
  return { body: token.slice(0, cut), mac: token.slice(cut + 1) };
}

const nowSeconds = (now) => Math.floor(now() / 1000);

// ==========================================
// Admin session cookies
// ==========================================

function mintSession(key, ttlSeconds, now = Date.now) {
  const body = '1.' + (nowSeconds(now) + ttlSeconds);
  return body + '.' + sign(key, SESSION_TAG, body);
}

function verifySession(key, value, now = Date.now) {
  const parts = splitMac(value, 128);
  if (!parts) return false;
  if (!constantTimeEqual(parts.mac, sign(key, SESSION_TAG, parts.body))) return false;

  // Signed input only, from here down.
  const fields = parts.body.split('.');
  if (fields.length !== 2 || fields[0] !== '1') return false;
  const exp = Number(fields[1]);
  return Number.isSafeInteger(exp) && exp > nowSeconds(now);
}

// ==========================================
// Provisioning invites
//
// Format: 1.<exp>.<label>.<nonce>.<mac>
//
// '.' is a safe delimiter: base64url uses '-' and '_' but never '.', and labels
// are [a-z0-9_-] (see users.js). The label travels in plaintext on purpose —
// the invitee is the person it names, so it discloses nothing to them, and it
// keeps resolution stateless.
// ==========================================

const FORGED = Object.freeze({ ok: false, reason: 'forged' });

function mintInvite(key, label, ttlSeconds, nonce, now = Date.now) {
  const exp = nowSeconds(now) + ttlSeconds;
  const body = `1.${exp}.${label}.${nonce}`;
  return { token: body + '.' + sign(key, INVITE_TAG, body), exp, nonce };
}

/**
 * @returns {{ok:true,label,exp,nonce}}
 *        | {{ok:false,reason:'stale',label,nonce}}
 *        | {{ok:false,reason:'forged'}}
 *
 * 'forged' means the caller should be served the decoy — a probe must not learn
 * that this endpoint exists. 'stale' is only ever reachable with a valid MAC,
 * which proves the operator minted it, so telling that holder it expired
 * discloses nothing new.
 */
function verifyInvite(key, token, now = Date.now) {
  const parts = splitMac(token, 200);
  if (!parts) return FORGED;
  if (!constantTimeEqual(parts.mac, sign(key, INVITE_TAG, parts.body))) return FORGED;

  // Signed input only, from here down.
  const fields = parts.body.split('.');
  if (fields.length !== 4 || fields[0] !== '1') return FORGED;

  const exp = Number(fields[1]);
  if (!Number.isSafeInteger(exp)) return FORGED;

  const label = fields[2];
  const nonce = fields[3];
  if (!label || !nonce) return FORGED;

  if (exp <= nowSeconds(now)) return { ok: false, reason: 'stale', label, nonce };
  return { ok: true, label, exp, nonce };
}

// ==========================================
// Burn store — best-effort single use
//
// In-memory and per-process, so a deploy, restart, OOM or host migration empties
// it, and a second machine does not share it. The TTL is therefore the real
// security boundary; this is a UX nicety that stops a link being passed around
// casually. Never document invites as single-use.
// ==========================================

function createBurnStore({ max = 4096 } = {}) {
  const seen = new Map();   // nonce -> { firstUsedAt, expiresAt }

  function sweep(now) {
    for (const [nonce, entry] of seen) {
      if (entry.expiresAt <= now) seen.delete(nonce);
    }
  }

  return {
    /**
     * First call starts a short grace window and returns true; later calls
     * return true only while still inside it.
     *
     * The grace window is what makes this usable on a phone: pull-to-refresh is
     * reflexive, and without it one accidental refresh loses the config forever.
     */
    claim(nonce, expiresAtMs, graceMs, now = Date.now()) {
      const hit = seen.get(nonce);
      if (hit) return now - hit.firstUsedAt < graceMs;

      if (seen.size >= max) sweep(now);
      if (seen.size >= max) return false;   // pathological: fail closed

      seen.set(nonce, { firstUsedAt: now, expiresAt: expiresAtMs });
      return true;
    },

    get size() {
      return seen.size;
    }
  };
}

module.exports = {
  b64url,
  constantTimeEqual,
  tokensMatch,
  subkey,
  sign,
  mintSession,
  verifySession,
  mintInvite,
  verifyInvite,
  createBurnStore,
  SESSION_TAG,
  INVITE_TAG,
  MAC_BYTES
};
