'use strict';

// Fetch the SHA-256 fingerprint of the certificate a TLS endpoint actually
// presents, in the lowercase hex form Xray's `pinnedPeerCertSha256` expects.
//
// This exists for domain-fronted client configs: the tunnel dials the real VPS
// but sends a spoofed (allowed) SNI, so certificate verification cannot be by
// hostname. Pinning the served leaf cert keeps the connection authenticated to
// the real server while the SNI lies to the censor's SNI filter — strictly
// better than the deprecated allowInsecure, which trusted anything.
//
// The pin is of whatever cert is served FOR THE SPOOFED SNI — behind nginx an
// unknown SNI falls to the default_server cert — so always probe with the same
// servername the client will send, not the real hostname.
//
// Built-in `tls` only (fingerprint256 is provided by Node): no npm dependency,
// so this ships in the image untouched — see test/image.test.js.

const tls = require('tls');

const PIN_RE = /^[0-9a-f]{64}$/;

/**
 * Connect and read the leaf certificate, returning its pin plus a short
 * description for confirmation (so an operator can see they are pinning the real
 * edge cert, not an interceptor's).
 *
 * `pin` is 64 lowercase hex chars, no colons — exactly Xray's
 * pinnedPeerCertSha256 form. rejectUnauthorized is false on purpose: we are not
 * trusting the certificate, we are fingerprinting whatever is presented (which,
 * for a spoofed SNI, will not match the name anyway).
 *
 * @returns {Promise<{pin:string, subject:string, issuer:string, validTo:string}>}
 *          rejects on timeout, no cert, or error.
 */
function fetchCertInfo(host, servername, { port = 443, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, info) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (e) { /* already gone */ }
      if (err) reject(err); else resolve(info);
    };

    const socket = tls.connect(
      { host, port, servername, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.fingerprint256) return done(new Error('no peer certificate'));
        const pin = cert.fingerprint256.replace(/:/g, '').toLowerCase();
        if (!PIN_RE.test(pin)) return done(new Error(`unexpected fingerprint: ${pin}`));
        done(null, {
          pin,
          subject: (cert.subject && cert.subject.CN) || '?',
          issuer: (cert.issuer && cert.issuer.CN) || '?',
          validTo: cert.valid_to || '?'
        });
      }
    );
    socket.setTimeout(timeoutMs, () => done(new Error(`cert probe timed out after ${timeoutMs}ms`)));
    socket.on('error', (e) => done(e));
  });
}

/** Just the pin — the form the config and the cache consume. */
function fetchCertPin(host, servername, opts) {
  return fetchCertInfo(host, servername, opts).then((info) => info.pin);
}

/**
 * A lazy, self-refreshing pin holder for the server's provisioning endpoint.
 *
 * No timer is armed at construction — that keeps createServer() side-effect
 * free (no listen, no timers), which the whole server module is careful to
 * preserve. The first probe fires on the first get(); afterwards the value is
 * cached and only re-probed when stale, in the background, so a stale hit is
 * still instant. A failed probe keeps the last good value; get() returns null
 * only while no probe has ever succeeded, letting the caller degrade to the
 * standard (non-fronted) config rather than fail.
 */
function createPinCache({ host, servername, port = 443, ttlMs = 6 * 3600 * 1000, timeoutMs = 5000 }) {
  let current = null;
  let fetchedAt = 0;
  let inFlight = null;

  const refresh = () => {
    if (!inFlight) {
      inFlight = fetchCertPin(host, servername, { port, timeoutMs })
        .then((pin) => { current = pin; fetchedAt = Date.now(); })
        .catch(() => { /* keep the last good value */ })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  };

  return {
    async get() {
      const stale = Date.now() - fetchedAt > ttlMs;
      if (current && !stale) return current;
      const probe = refresh();
      if (!current) await probe;   // nothing cached yet: must wait for a result
      return current;               // may still be null if that probe failed
    },
    stop() { /* no timer to clear; kept for symmetry with dns.stop() */ }
  };
}

module.exports = { fetchCertInfo, fetchCertPin, createPinCache };
