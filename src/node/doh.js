'use strict';

// A DNS-over-HTTPS resolver, shaped to drop into the seam dnscache.js already
// documents: "anything with resolve4(host, cb)".
//
// Why HTTPS and not DoT, given the same wire format either way: https.Agent
// with keepAlive hands us pooling and reconnection, where a TLS socket would
// mean owning its idle timeout and demultiplexing concurrent queries by message
// id. Node's https is HTTP/1.1 only, which is fine — the endpoint serves both.
//
// The fallback is the point of this file, not the DoH. Every tunnelled
// destination resolves through here, so a resolver outage without a fallback
// takes down the whole service in a way that reads as "the server is broken".

const https = require('https');
const dns = require('dns');

const { log: defaultLog } = require('./log.js');

const TYPE_A = 1;
const CLASS_IN = 1;

/**
 * Encode a DNS query for `host`'s A records.
 *
 * Id is 0: the transport is a distinct HTTP request per query, so there is
 * nothing to correlate and RFC 8484 recommends 0 for cache friendliness.
 */
function encodeQuery(host) {
  const labels = host.split('.').filter(Boolean);
  for (const l of labels) {
    if (l.length > 63) throw new Error(`label too long: ${l}`);
  }

  const size = 12 + labels.reduce((n, l) => n + 1 + Buffer.byteLength(l), 0) + 1 + 4;
  const b = Buffer.alloc(size);

  b.writeUInt16BE(0, 0);          // id
  b.writeUInt16BE(0x0100, 2);     // recursion desired
  b.writeUInt16BE(1, 4);          // one question

  let o = 12;
  for (const l of labels) {
    o = b.writeUInt8(Buffer.byteLength(l), o);
    o += b.write(l, o);
  }
  o = b.writeUInt8(0, o);
  o = b.writeUInt16BE(TYPE_A, o);
  b.writeUInt16BE(CLASS_IN, o);

  return b;
}

/** Skip a name at `o`, following the compression pointer if there is one. */
function skipName(b, o) {
  for (;;) {
    if (o >= b.length) throw new Error('truncated name');
    const len = b[o];
    if (len === 0) return o + 1;
    // 0xc0 marks a pointer, which is always the last thing in a name.
    if ((len & 0xc0) === 0xc0) return o + 2;
    o += len + 1;
  }
}

/**
 * @returns {string[]} the A records, in order.
 * @throws on a malformed message or any rcode other than NOERROR.
 */
function decodeAnswer(b) {
  if (b.length < 12) throw new Error('short message');

  const rcode = b[3] & 0x0f;
  if (rcode !== 0) throw new Error(`rcode ${rcode}`);

  const qdcount = b.readUInt16BE(4);
  const ancount = b.readUInt16BE(6);

  let o = 12;
  for (let i = 0; i < qdcount; i++) o = skipName(b, o) + 4;

  const addresses = [];
  for (let i = 0; i < ancount; i++) {
    o = skipName(b, o);
    if (o + 10 > b.length) throw new Error('truncated record');
    const type = b.readUInt16BE(o);
    const rdlen = b.readUInt16BE(o + 8);
    o += 10;
    if (o + rdlen > b.length) throw new Error('truncated rdata');
    // CNAMEs and anything else in the chain are skipped; only the A records at
    // the end of it are addresses we can connect to.
    if (type === TYPE_A && rdlen === 4) addresses.push(Array.from(b.subarray(o, o + 4)).join('.'));
    o += rdlen;
  }

  return addresses;
}

/** The default transport: one GET per query, over a pooled keep-alive agent. */
function httpsTransport(url, timeoutMs) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
  const target = new URL(url);

  return function request(query, cb) {
    // base64url, unpadded, per RFC 8484.
    const q = query.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    let done = false;
    const finish = (err, body) => {
      if (done) return;
      done = true;
      cb(err, body);
    };

    const req = https.request({
      agent,
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      // No `lookup` override here, deliberately: the endpoint's own hostname
      // must resolve through the system resolver, or this recurses into itself.
      path: `${target.pathname}?dns=${q}`,
      method: 'GET',
      headers: { accept: 'application/dns-message' }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return finish(new Error(`http ${res.statusCode}`));
        finish(null, Buffer.concat(chunks));
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', finish);
    req.end();
  };
}

/**
 * @param {object}   opts
 * @param {string}   opts.url                DoH endpoint; required
 * @param {function} opts.request            (query, cb) => void — injectable for tests
 * @param {object}   opts.fallback           anything with resolve4; defaults to node dns
 * @param {number}   opts.timeoutMs
 * @param {number}   opts.failureThreshold   consecutive failures before the breaker opens
 * @param {number}   opts.coolOffMs          how long it stays open
 * @param {function} opts.logger             (level, msg) => void
 * @param {function} opts.now                () => epoch millis
 */
function createDohResolver(opts = {}) {
  if (!opts.url && !opts.request) throw new Error('createDohResolver needs a url');

  const timeoutMs = opts.timeoutMs || 3000;
  const failureThreshold = opts.failureThreshold || 3;
  const coolOffMs = opts.coolOffMs || 30000;
  const fallback = opts.fallback || dns;
  const logger = opts.logger || defaultLog;
  const now = opts.now || Date.now;
  const request = opts.request || httpsTransport(opts.url, timeoutMs);

  let consecutiveFailures = 0;
  let openUntil = 0;

  function useFallback(host, why, cb) {
    if (why) logger('WARN', `DoH ${why} for ${host}; falling back`);
    fallback.resolve4(host, cb);
  }

  function noteFailure(host, why, cb) {
    consecutiveFailures += 1;
    if (consecutiveFailures === failureThreshold) {
      openUntil = now() + coolOffMs;
      logger('WARN', `DoH failed ${consecutiveFailures}x; using the system resolver ` +
                     `for ${Math.round(coolOffMs / 1000)}s`);
    }
    useFallback(host, why, cb);
  }

  return {
    resolve4(host, cb) {
      // Breaker open: an outage should cost one timeout, not one per lookup.
      if (now() < openUntil) return useFallback(host, null, cb);

      let query;
      try {
        query = encodeQuery(host);
      } catch (e) {
        // A name we cannot even encode is not a resolver failure, so it must
        // not count toward the breaker.
        return useFallback(host, null, cb);
      }

      request(query, (err, body) => {
        if (err) return noteFailure(host, err.message, cb);

        let addresses;
        try {
          addresses = decodeAnswer(body);
        } catch (e) {
          return noteFailure(host, e.message, cb);
        }

        if (addresses.length === 0) return noteFailure(host, 'no A record', cb);

        consecutiveFailures = 0;
        cb(null, addresses);
      });
    },

    // For tests and for anyone reasoning about the breaker from outside.
    get state() {
      return { consecutiveFailures, open: now() < openUntil };
    }
  };
}

module.exports = { createDohResolver, encodeQuery, decodeAnswer };
