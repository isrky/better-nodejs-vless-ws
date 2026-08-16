'use strict';

// Token-bucket rate limiting for the admin and invite endpoints.
//
// In-memory and per-process, like everything else here: this is a CPU and log
// budget control, not a security boundary. A 128-bit MAC needs no rate limit to
// resist guessing; what this stops is a probe flood burning CPU on a 256 MB
// shared-cpu-1x machine and filling the log budget.
//
// No timer: buckets refill lazily on read and the map is swept on insert, so
// nothing here can hold the event loop open.

function createRateLimiter({ capacity, refillPerSecond, maxKeys = 4096 } = {}) {
  const buckets = new Map();

  /** Drop buckets that have refilled to full — i.e. callers who went idle. */
  function sweep(now) {
    for (const [key, bucket] of buckets) {
      const refilled = bucket.tokens + ((now - bucket.at) / 1000) * refillPerSecond;
      if (refilled >= capacity) buckets.delete(key);
    }
  }

  return {
    /** @returns true if the caller may proceed. */
    allow(key, now = Date.now()) {
      let bucket = buckets.get(key);

      if (bucket === undefined) {
        if (buckets.size >= maxKeys) sweep(now);
        // Still full of live buckets: fail closed rather than grow without bound.
        if (buckets.size >= maxKeys) return false;
        bucket = { tokens: capacity, at: now };
        buckets.set(key, bucket);
      }

      const refilled = bucket.tokens + ((now - bucket.at) / 1000) * refillPerSecond;
      bucket.tokens = Math.min(capacity, refilled);
      bucket.at = now;

      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },

    get size() {
      return buckets.size;
    }
  };
}

/**
 * The caller's IP.
 *
 * On Fly the socket peer is the edge proxy, so the real client is only in a
 * header — and a header is only trustworthy when we know we are behind that
 * proxy. Untrusted, everything shares one bucket: a degraded global limit,
 * but never a spoofable-key bypass.
 */
function clientIp(req, socket, config) {
  if (config.trustProxy) {
    const fly = req.headers['fly-client-ip'];
    if (fly) return fly;
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return socket.remoteAddress || '?';
}

module.exports = { createRateLimiter, clientIp };
