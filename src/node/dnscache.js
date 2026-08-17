'use strict';

// A/AAAA cache in front of UDP sends, with in-flight request coalescing.
//
// UDP traffic is dominated by repeated sends to the same handful of hosts, and
// the datagram path has no connection to amortise a lookup over. Without this,
// every packet would pay a resolver round trip; without the pending queue, a
// burst of packets to a cold host would each start their own lookup.

const dns = require('dns');

const { log: defaultLog } = require('./log.js');

const IPV4_LITERAL = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * @param {object}   opts
 * @param {number}   opts.ttl            seconds to cache a resolved address
 * @param {number}   opts.sweepInterval  seconds between expiry sweeps
 * @param {object}   opts.resolver       anything with resolve4(host, cb)
 * @param {function} opts.logger         (level, msg) => void
 * @param {function} opts.now            () => epoch millis
 */
function createDnsCache(opts = {}) {
  const ttl = opts.ttl || 300;
  const sweepInterval = opts.sweepInterval || 60;
  const resolver = opts.resolver || dns;
  const logger = opts.logger || defaultLog;
  const now = opts.now || Date.now;

  const cache = new Map();
  const pending = new Map();

  const seconds = () => Math.floor(now() / 1000);

  // unref'd so this timer never keeps the process alive by itself: the
  // listening server is what should hold the event loop open. Without it,
  // requiring this module would stop `node --test` from ever exiting.
  const sweep = setInterval(() => {
    const t = seconds();
    for (const [host, entry] of cache) {
      if (t >= entry.expires) cache.delete(host);
    }
  }, sweepInterval * 1000);
  sweep.unref();

  /**
   * Resolve `host` to a single IPv4 address through the cache.
   *
   * IP literals bypass the resolver entirely. Concurrent callers for the same
   * cold host share one lookup and are flushed together. Literals, cache hits
   * and an empty host call back synchronously — the UDP path depends on that.
   */
  function resolve(host, cb) {
    if (!host) return cb('Empty Host');

    // Dotted quad, or anything with a colon (IPv6 literal) — nothing to look up.
    if (IPV4_LITERAL.test(host) || host.includes(':')) return cb(null, host);

    const t = seconds();
    const entry = cache.get(host);
    if (entry && t < entry.expires) return cb(null, entry.address);

    const queued = pending.get(host);
    if (queued) {
      queued.push(cb);
      return;
    }
    pending.set(host, [cb]);

    resolver.resolve4(host, (err, addresses) => {
      const queue = pending.get(host) || [];
      pending.delete(host);

      if (!err && addresses && addresses[0]) {
        const address = addresses[0];
        cache.set(host, { address, expires: seconds() + ttl });
        for (const item of queue) item(null, address);
        return;
      }

      logger('WARN', 'DNS Resolution Failed: ' + host);
      for (const item of queue) item(err || 'Resolution Failed');
    });
  }

  /**
   * A drop-in for the `lookup` option of net.createConnection.
   *
   * This lives here rather than at the call sites because there are two of
   * them — the plain TCP relay and the Mux substream opener — and wiring only
   * one leaves the other on getaddrinfo. With mux enabled in every client
   * config we ship, the mux path carries nearly all traffic, so missing it
   * looks exactly like the resolver not working at all.
   *
   * A-only, so anything it cannot answer (an IPv6-only host, most obviously)
   * falls through to Node's own lookup rather than becoming unreachable.
   */
  function lookup(hostname, options, cb) {
    resolve(hostname, (err, address) => {
      if (err || !address) return dns.lookup(hostname, options, cb);
      // net asks for the array form when it wants every candidate.
      if (options && options.all) return cb(null, [{ address, family: 4 }]);
      cb(null, address, 4);
    });
  }

  /** Send `payload` to host:port, resolving `host` through the cache first. */
  function resolveAndSend(sock, payload, port, host, callback) {
    resolve(host, (err, address) => {
      if (err) return callback && callback(err);
      if (!sock) return;
      try {
        sock.send(payload, port, address, callback);
      } catch (e) { /* socket closed while we were resolving */ }
    });
  }

  return {
    resolve,
    lookup,
    resolveAndSend,
    clear() {
      cache.clear();
      pending.clear();
    },
    stop() {
      clearInterval(sweep);
    },
    get size() {
      return cache.size;
    }
  };
}

module.exports = { createDnsCache };
