'use strict';

// VLESS CMD 3 — Mux.Cool, plus the xUDP datagram mode layered on it.
//
// One WebSocket carries many independent substreams, each tagged with a 16-bit
// id. Frame layout:
//
//   u16 metaLen | meta[metaLen] | (u16 dataLen | data[dataLen])?
//
// and meta itself is:
//
//   u16 id | u8 cmd | u8 opt | (u8 network | u16 port | address)?
//
// cmd 1 = New substream, 2 = Keep (carry data), 3 = End.
// opt bit 0 = a data section follows.
// network 1 = TCP, 2 = UDP.
//
// Mirrors src/worker/mux.mjs, which implements the same protocol against
// Workers' stream APIs. The two deliberately share only parseMuxAddress and
// ByteQueue (src/vless.js) — this side is event/callback shaped and forcing a
// common abstraction would be worse than the small duplication.

const net = require('net');
const dgram = require('dgram');

const { OPCODE } = require('./wsframe.js');
const { ByteQueue, isBlockedDomain, parseMuxAddress } = require('../vless.js');

const MUX_CMD_NEW = 1;
const MUX_CMD_KEEP = 2;
const MUX_CMD_END = 3;

const NETWORK_TCP = 1;
const NETWORK_UDP = 2;

// Offset of the address block within meta: id(2) + cmd(1) + opt(1) +
// network(1) + port(2).
const META_ADDRESS_OFFSET = 7;

const EMPTY = new Uint8Array(0);

/** meta bytes for "substream `id`: keep alive, data follows". */
function metaKeep(id) {
  return Buffer.from([(id >>> 8) & 0xff, id & 0xff, MUX_CMD_KEEP, 1]);
}

/** meta bytes for "substream `id`: ended". */
function metaEnd(id) {
  return Buffer.from([(id >>> 8) & 0xff, id & 0xff, MUX_CMD_END, 0]);
}

/**
 * meta bytes for a UDP reply, carrying the source address back to the client
 * so it can demultiplex responses from different peers on one substream.
 */
function metaUdpFrom(id, rinfo) {
  const address = (rinfo.address || rinfo.ip || '0.0.0.0').replace(/^::ffff:/, '');
  const quad = address.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!quad) return metaKeep(id);

  return Buffer.from([
    (id >>> 8) & 0xff, id & 0xff,
    MUX_CMD_KEEP, 1,
    NETWORK_UDP,
    (rinfo.port >>> 8) & 0xff, rinfo.port & 0xff,
    1,
    parseInt(quad[1], 10), parseInt(quad[2], 10), parseInt(quad[3], 10), parseInt(quad[4], 10)
  ]);
}

class MuxSession {
  #session;
  #queue = new ByteQueue();
  #tcp = new Map();      // id -> { handle, connected, pending, record }
  #udp = new Map();      // id -> { socket, host, port, record }
  #closed = false;

  constructor(session, initial) {
    this.#session = session;
    session.stats.noteMuxSession();
    session.log('MUX', 'XUDP & Mux.Cool Session Started');
    if (initial && initial.length > 0) this.write(initial);
  }

  get #dead() {
    return this.#session.dead || this.#closed;
  }

  write(payload) {
    if (payload && payload.length > 0) this.#queue.push(payload);
    this.drain();
  }

  /** Parse and dispatch as many complete frames as are buffered. */
  drain() {
    const q = this.#queue;

    for (;;) {
      if (q.size < 4) return;

      const metaLen = (q.at(0) << 8) | q.at(1);

      // meta must at least carry id + cmd + opt. Anything shorter means the
      // stream is out of sync; drop one byte and resync on the next chunk.
      if (metaLen < 4 || metaLen > 65535) {
        this.#session.log('MUX-ERR', `Invalid metaLen: ${metaLen}, dropping malformed frame`);
        q.consume(1);
        return;
      }

      if (q.size < 2 + metaLen) return;

      const opt = q.at(5);
      const hasData = (opt & 1) === 1;

      let dataLen = 0;
      if (hasData) {
        if (q.size < 2 + metaLen + 2) return;
        dataLen = (q.at(2 + metaLen) << 8) | q.at(3 + metaLen);
        if (q.size < 2 + metaLen + 2 + dataLen) return;
      }

      const meta = q.slice(2, 2 + metaLen);
      const data = hasData ? q.slice(4 + metaLen, 4 + metaLen + dataLen) : EMPTY;

      q.consume(2 + metaLen + (hasData ? 2 + dataLen : 0));

      const id = (meta[0] << 8) | meta[1];
      const cmd = meta[2];

      if (cmd === MUX_CMD_NEW) {
        if (!this.#onNew(id, meta, metaLen, hasData, data)) return;
      } else if (cmd === MUX_CMD_KEEP) {
        if (!this.#onKeep(id, meta, metaLen, hasData, data)) return;
      } else if (cmd === MUX_CMD_END) {
        this.endStream(id);
      } else {
        this.#session.log('MUX-ERR', `[${id}] Unknown Mux command: ${cmd}`);
      }
    }
  }

  /**
   * Read network/port/address out of meta. Returns null (and logs) when the
   * block is truncated or the address type is unknown; the caller then stops
   * parsing, matching the original single-file behaviour.
   */
  #readTarget(id, meta, metaLen, label) {
    if (metaLen < 8) {
      this.#session.log('MUX-ERR', `[${id}] ${label} meta too short for address: ${metaLen} bytes`);
      return null;
    }

    const network = meta[4];
    const port = (meta[5] << 8) | meta[6];
    const address = parseMuxAddress(meta, META_ADDRESS_OFFSET);

    if (!address) {
      this.#session.log('MUX-ERR', `[${id}] ${label} address truncated or unknown ATYP ${meta[7]}`);
      return null;
    }

    return { network, port, host: address.host };
  }

  #onNew(id, meta, metaLen, hasData, data) {
    const target = this.#readTarget(id, meta, metaLen, 'New');
    if (!target) return false;

    const { network, port, host } = target;

    // The direct (non-mux) path gets this check from parseVlessHeader, and the
    // Worker's mux path does it too — without it here, any mux-capable client
    // could route around the blocklist entirely.
    if (isBlockedDomain(host)) {
      this.#session.log('MUX-ERR', `[${id}] Blocked Domain: ${host}`);
      this.#sendEnd(id);
      return true;
    }

    if (network === NETWORK_TCP) {
      // A New frame may carry the substream's first payload. The single-file
      // version parsed `data` here and then dropped it on the TCP branch, so
      // the opening bytes of every mux TCP substream were silently lost;
      // src/worker/mux.mjs has always written them through as `initial`.
      this.#openTcp(id, host, port, hasData ? data : null);
    } else if (network === NETWORK_UDP) {
      const entry = this.#openUdp(id, host, port);
      if (hasData && data.length > 0) this.#sendUdp(entry, id, data);
    } else {
      this.#session.log('MUX-ERR', `[${id}] Unknown network type: ${network}`);
    }
    return true;
  }

  #onKeep(id, meta, metaLen, hasData, data) {
    // A Keep frame may re-state the target, which is how xUDP retargets a
    // datagram substream at a new peer without opening a new one.
    if (metaLen > 4 && meta[4] === NETWORK_UDP) {
      const target = this.#readTarget(id, meta, metaLen, 'Keep');
      if (!target) return false;

      if (isBlockedDomain(target.host)) {
        this.#session.log('MUX-ERR', `[${id}] Blocked Domain: ${target.host}`);
        this.#sendEnd(id);
        return true;
      }

      const existing = this.#udp.get(id);
      if (existing) {
        existing.host = target.host;
        existing.port = target.port;
        if (existing.record) {
          existing.record.host = target.host;
          existing.record.port = target.port;
        }
      } else {
        this.#openUdp(id, target.host, target.port);
      }
    }

    if (!hasData || data.length === 0) return true;

    const tcp = this.#tcp.get(id);
    if (tcp) {
      this.#session.stats.addTx(this.#session.connInfo, tcp.record, data.length);
      if (tcp.connected) tcp.handle.write(data);
      else tcp.pending.push(data);
      return true;
    }

    const udp = this.#udp.get(id);
    if (udp) this.#sendUdp(udp, id, data);

    return true;
  }

  #openTcp(id, host, port, initial) {
    const record = this.#session.stats.startStream(this.#session.connInfo, 'TCP', host, port);
    this.#session.log('MUX-TCP', `Multiplexed TCP connecting to ${host}:${port}`);

    const entry = { handle: null, connected: false, pending: new ByteQueue(), record };
    this.#tcp.set(id, entry);

    if (initial && initial.length > 0) entry.pending.push(initial);

    entry.handle = net.createConnection({ host, port }, () => {
      entry.connected = true;
      if (entry.pending.size === 0) return;
      const buffered = entry.pending.flatten();
      this.#session.stats.addTx(this.#session.connInfo, record, buffered.length);
      try { entry.handle.write(buffered); } catch (e) { /* closed underneath us */ }
      entry.pending.clear();
    });

    entry.handle.on('data', (reply) => {
      if (this.#dead) return;
      this.#session.stats.addRx(this.#session.connInfo, record, reply.length);
      if (!this.#session.sendMux(metaKeep(id), true, reply)) {
        this.#session.pauseSource(entry.handle);
      }
    });

    entry.handle.on('close', () => {
      if (this.#dead) return;
      this.#sendEnd(id);
      this.endStream(id);
    });

    entry.handle.on('error', (e) => {
      this.#session.log('MUX-ERR', `[${id}][TCP] Error: ${e}`);
      this.endStream(id);
    });

    return entry;
  }

  #openUdp(id, host, port) {
    const record = this.#session.stats.startStream(this.#session.connInfo, 'UDP', host, port);
    this.#session.log('MUX-UDP', `Multiplexed UDP initialized for target ${host}:${port}`);

    const socket = dgram.createSocket('udp4');
    socket.bind(0, '0.0.0.0');

    const entry = { socket, host, port, record };
    this.#udp.set(id, entry);

    socket.on('message', (reply, rinfo) => {
      if (this.#dead) return;
      this.#session.stats.addRx(this.#session.connInfo, record, reply.length);
      this.#session.sendMux(metaUdpFrom(id, rinfo), true, reply);
    });

    socket.on('error', (e) => {
      this.#session.log('MUX-ERR', `[${id}][UDP] Socket Error: ${e}`);
      this.endStream(id);
    });

    return entry;
  }

  #sendUdp(entry, id, data) {
    if (!entry) return;
    this.#session.stats.addTx(this.#session.connInfo, entry.record, data.length);
    this.#session.dns.resolveAndSend(entry.socket, data, entry.port, entry.host, () => {});
  }

  #sendEnd(id) {
    this.#session.sendMux(metaEnd(id), false, EMPTY);
  }

  /** Tear down one substream. Safe to call more than once. */
  endStream(id) {
    const tcp = this.#tcp.get(id);
    if (tcp) {
      this.#tcp.delete(id);
      this.#session.stats.endStream(tcp.record);
      tcp.pending.clear();
      if (tcp.handle) {
        tcp.handle.removeAllListeners('data');
        tcp.handle.removeAllListeners('drain');
        tcp.handle.removeAllListeners('error');
        tcp.handle.removeAllListeners('close');
        try { tcp.handle.destroy(); } catch (e) { /* already gone */ }
      }
    }

    const udp = this.#udp.get(id);
    if (udp) {
      this.#udp.delete(id);
      this.#session.stats.endStream(udp.record);
      udp.socket.removeAllListeners('message');
      udp.socket.removeAllListeners('error');
      try { udp.socket.close(); } catch (e) { /* already closed */ }
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const id of [...this.#tcp.keys()]) this.endStream(id);
    for (const id of [...this.#udp.keys()]) this.endStream(id);
    this.#queue.clear();
  }
}

function createMuxSession(session, initial) {
  return new MuxSession(session, initial);
}

module.exports = { createMuxSession, MuxSession, OPCODE };
