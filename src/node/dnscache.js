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
   * Send `payload` to host:port, resolving `host` through the cache first.
   *
   * IP literals bypass the resolver entirely. Concurrent sends to the same
   * unresolved host share one lookup and are flushed together.
   */
  function resolveAndSend(sock, payload, port, host, callback) {
    if (!host) return callback && callback('Empty Host');

    function send(address) {
      if (!sock) return;
      sock.send(payload, port, address, callback);
    }

    // Dotted quad, or anything with a colon (IPv6 literal) — nothing to look up.
    if (IPV4_LITERAL.test(host) || host.includes(':')) return send(host);

    const t = seconds();
    const entry = cache.get(host);
    if (entry && t < entry.expires) return send(entry.address);

    const queued = pending.get(host);
    if (queued) {
      queued.push({ sock, payload, port, callback });
      return;
    }
    pending.set(host, [{ sock, payload, port, callback }]);

    resolver.resolve4(host, (err, addresses) => {
      const queue = pending.get(host);
      pending.delete(host);

      if (!err && addresses && addresses[0]) {
        const address = addresses[0];
        cache.set(host, { address, expires: seconds() + ttl });
        if (queue) {
          for (const item of queue) {
            try {
              if (item.sock) item.sock.send(item.payload, item.port, address, item.callback);
            } catch (e) { /* socket closed while we were resolving */ }
          }
        }
        return;
      }

      logger('WARN', 'DNS Resolution Failed: ' + host);
      if (queue) {
        for (const item of queue) {
          if (item.callback) item.callback(err || 'Resolution Failed');
        }
      }
    });
  }

  return {
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
