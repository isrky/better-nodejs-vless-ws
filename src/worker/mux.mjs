import { connect } from 'cloudflare:sockets';
import vless from '../vless.js';
import { getProxyIp } from './config.mjs';
import { dohQuery } from './dns.mjs';
import { splitProxy } from './relay.mjs';
import { WS_OPEN, ignoreRejection, safeClose, safeSend } from './wsstream.mjs';

const { ByteQueue, VLESS_OK_HEADER, isBlockedDomain, parseMuxAddress } = vless;

// Mux dataLen is 16-bit, so reads off a TCP socket must be split before framing.
const MAX_MUX_CHUNK = 65535;

/**
 * Mux.Cool session (VLESS CMD 3). Many logical substreams share one WebSocket.
 *
 * Frame layout: [metaLen:2][meta][dataLen:2][data]  (data present iff meta[3]&1)
 *   meta = [id:2][cmd:1][opt:1] + tail
 *     cmd 1 New:  tail = [network:1][port:2][atyp:1][addr]   network 1=TCP 2=UDP
 *     cmd 2 Keep: same tail, but only when metaLen > 4 and network === 2
 *     cmd 3 End:  no tail
 */
class MuxSession {
  constructor(ws, env, ctx) {
    this.ws = ws;
    this.env = env;
    this.ctx = ctx;
    this.queue = new ByteQueue();
    this.streams = new Map();
    this.closed = false;
    // Substream work runs detached from the frame loop so one slow origin
    // cannot stall the others. Tracking it lets the session await everything
    // on teardown, rather than leaving promises to outlive the request
    // context and be cancelled by the runtime.
    this.tasks = new Set();
  }

  track(promise) {
    const task = promise.catch(() => {}).finally(() => this.tasks.delete(task));
    this.tasks.add(task);
    return task;
  }

  async settle() {
    while (this.tasks.size) {
      await Promise.allSettled([...this.tasks]);
    }
  }

  // ---- outbound framing ----

  sendFrame(meta, data) {
    if (this.closed || this.ws.readyState !== WS_OPEN) return;
    const dataLen = data ? data.byteLength : 0;
    const out = new Uint8Array(2 + meta.length + (data ? 2 + dataLen : 0));
    out[0] = (meta.length >>> 8) & 0xff;
    out[1] = meta.length & 0xff;
    out.set(meta, 2);
    if (data) {
      out[2 + meta.length] = (dataLen >>> 8) & 0xff;
      out[3 + meta.length] = dataLen & 0xff;
      out.set(data, 4 + meta.length);
    }
    safeSend(this.ws, out);
  }

  sendKeep(id, data) {
    for (let off = 0; off < data.byteLength; off += MAX_MUX_CHUNK) {
      const end = Math.min(off + MAX_MUX_CHUNK, data.byteLength);
      this.sendFrame(
        new Uint8Array([(id >>> 8) & 0xff, id & 0xff, 2, 1]),
        data.subarray(off, end)
      );
    }
  }

  /** xUDP reply: the source address travels in the meta block. */
  sendUdpKeep(id, host, port, data) {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
    const meta = m
      ? new Uint8Array([
          (id >>> 8) & 0xff, id & 0xff, 2, 1, 2,
          (port >>> 8) & 0xff, port & 0xff, 1,
          +m[1], +m[2], +m[3], +m[4]
        ])
      : new Uint8Array([(id >>> 8) & 0xff, id & 0xff, 2, 1]);
    this.sendFrame(meta, data);
  }

  sendEnd(id) {
    this.sendFrame(new Uint8Array([(id >>> 8) & 0xff, id & 0xff, 3, 0]), null);
  }

  // ---- inbound framing ----

  drain() {
    for (;;) {
      if (this.closed) return;
      const buf = this.queue.flatten();
      if (buf.length < 4) return;

      const metaLen = (buf[0] << 8) | buf[1];
      if (metaLen < 4) {
        // A desynced mux stream cannot be resynced meaningfully; tear it down.
        console.log('mux: invalid metaLen ' + metaLen + ', closing session');
        this.closeAll();
        safeClose(this.ws, 1002, 'mux desync');
        return;
      }
      if (buf.length < 2 + metaLen) return;

      const hasData = (buf[5] & 1) === 1;
      let dataLen = 0;
      if (hasData) {
        if (buf.length < 4 + metaLen) return;
        dataLen = (buf[2 + metaLen] << 8) | buf[3 + metaLen];
        if (buf.length < 4 + metaLen + dataLen) return;
      }

      // Copy before consuming: the handlers below are async and consume()
      // re-slices the backing store out from under any lingering view.
      const meta = buf.slice(2, 2 + metaLen);
      const data = hasData && dataLen > 0
        ? buf.slice(4 + metaLen, 4 + metaLen + dataLen)
        : null;

      this.queue.consume(2 + metaLen + (hasData ? 2 + dataLen : 0));

      const id = (meta[0] << 8) | meta[1];
      const cmd = meta[2];
      if (cmd === 1) this.onNew(id, meta, data);
      else if (cmd === 2) this.onKeep(id, meta, data);
      else if (cmd === 3) this.endStream(id);
    }
  }

  onNew(id, meta, data) {
    if (meta.length < 8) {
      this.sendEnd(id);
      return;
    }
    const network = meta[4];
    const port = (meta[5] << 8) | meta[6];
    const addr = parseMuxAddress(meta, 7);
    if (!addr || isBlockedDomain(addr.host)) {
      this.sendEnd(id);
      return;
    }

    if (network === 1) {
      // host/port and the opening bytes are retained so the substream can be
      // re-dialled through PROXYIP, exactly as the non-mux path does.
      const stream = {
        kind: 'tcp', socket: null, writer: null, chain: null, closed: false,
        host: addr.host, port, initial: data,
        sawData: false, wroteMore: false, retried: false
      };
      this.streams.set(id, stream);
      stream.chain = this.track(this.openTcp(id, stream, addr.host, port, data));
      return;
    }

    if (network === 2) {
      if (port !== 53) {
        this.sendEnd(id);
        return;
      }
      this.streams.set(id, { kind: 'udp', host: addr.host, port, closed: false });
      if (data) this.udpSend(id, addr.host, port, data);
      return;
    }

    this.sendEnd(id);
  }

  async openTcp(id, stream, host, port, data) {
    try {
      const socket = connect({ hostname: host, port });
      await socket.opened;
      if (stream.closed || this.closed) {
        ignoreRejection(socket.close());
        return;
      }
      stream.socket = socket;
      stream.writer = socket.writable.getWriter();
      if (data) {
        await stream.writer.ready;
        await stream.writer.write(data);
      }
      // Not awaited: the write chain must not block on the read pump.
      this.track(this.pumpTcp(id, stream));
    } catch {
      if (await this.retryViaProxy(id, stream)) return;
      this.sendEnd(id);
      this.endStream(id);
    }
  }

  async pumpTcp(id, stream) {
    try {
      await stream.socket.readable.pipeTo(new WritableStream({
        write: (chunk) => {
          if (this.closed || this.ws.readyState !== WS_OPEN) throw new Error('websocket closed');
          if (!stream.sawData) {
            stream.sawData = true;
            // No retry can happen now, so stop pinning the opening bytes.
            stream.initial = null;
          }
          this.sendKeep(id, chunk);
        }
      }));
    } catch {}
    if (stream.closed) return;
    if (await this.retryViaProxy(id, stream)) return;
    this.sendEnd(id);
    this.endStream(id);
  }

  /**
   * A substream whose dial failed, or which connected but produced nothing, is
   * the signature of a Cloudflare-proxied origin: Workers refuse to connect
   * back into Cloudflare's own edge on 80/443. Re-dial through the relay and
   * replay the opening bytes, per substream — one mux session carries many
   * destinations, and only the affected substream may be swapped.
   */
  async retryViaProxy(id, stream) {
    if (stream.sawData || stream.wroteMore || stream.retried) return false;
    if (stream.closed || this.closed) return false;
    const proxyIp = getProxyIp(this.env);
    if (!proxyIp) return false;
    stream.retried = true;

    const target = splitProxy(proxyIp, stream.port);
    try {
      const socket = connect({ hostname: target.hostname, port: target.port });
      await socket.opened;
      if (stream.closed || this.closed) {
        ignoreRejection(socket.close());
        return false;
      }
      const previous = stream.socket;
      stream.socket = socket;
      stream.writer = socket.writable.getWriter();
      if (previous) ignoreRejection(previous.close());
      if (stream.initial) {
        await stream.writer.ready;
        await stream.writer.write(stream.initial);
      }
      this.track(this.pumpTcp(id, stream));
      return true;
    } catch {
      return false;
    }
  }

  onKeep(id, meta, data) {
    // xUDP rebinds the target per packet, which is how one id serves many
    // UDP destinations.
    if (meta.length > 4 && meta[4] === 2) {
      if (meta.length < 8) return;
      const port = (meta[5] << 8) | meta[6];
      const addr = parseMuxAddress(meta, 7);
      if (!addr) return;
      const existing = this.streams.get(id);
      if (existing && existing.kind === 'udp') {
        existing.host = addr.host;
        existing.port = port;
      } else if (!existing) {
        this.streams.set(id, { kind: 'udp', host: addr.host, port, closed: false });
      }
    }

    if (!data) return;
    const stream = this.streams.get(id);
    if (!stream || stream.closed) return;

    if (stream.kind === 'tcp') {
      // Past this point the retry can no longer reproduce the conversation
      // faithfully: it replays only the opening bytes, so anything sent after
      // them would be lost. Record that and let retryViaProxy decline.
      stream.wroteMore = true;
      stream.initial = null;
      // Per-substream serialization. Without it, one slow origin would
      // head-of-line-block every other substream sharing this WebSocket.
      stream.chain = this.track(stream.chain.then(async () => {
        if (stream.closed || !stream.writer) return;
        await stream.writer.ready;
        await stream.writer.write(data);
      }).catch(() => {
        this.sendEnd(id);
        this.endStream(id);
      }));
    } else {
      this.udpSend(id, stream.host, stream.port, data);
    }
  }

  udpSend(id, host, port, data) {
    if (port !== 53) {
      this.sendEnd(id);
      this.endStream(id);
      return;
    }
    this.track(
      dohQuery(data, this.env, this.ctx).then((answer) => {
        if (this.streams.has(id)) this.sendUdpKeep(id, host, port, answer);
      })
    );
  }

  endStream(id) {
    const stream = this.streams.get(id);
    if (!stream) return;
    stream.closed = true;
    this.streams.delete(id);
    if (stream.socket) ignoreRejection(stream.socket.close());
  }

  closeAll() {
    this.closed = true;
    for (const stream of this.streams.values()) {
      stream.closed = true;
      if (stream.socket) ignoreRejection(stream.socket.close());
    }
    this.streams.clear();
  }
}

export async function runMuxSession(ws, readable, initial, env, ctx) {
  const session = new MuxSession(ws, env, ctx);

  // Unlike the TCP path, the VLESS reply is not piggybacked on the first data
  // frame: a mux session may sit idle for a while before any substream
  // produces output, and clients expect the reply promptly.
  safeSend(ws, VLESS_OK_HEADER);

  if (initial && initial.byteLength) {
    session.queue.push(initial);
    session.drain();
  }

  try {
    await readable.pipeTo(new WritableStream({
      write(chunk) {
        session.queue.push(chunk);
        session.drain();
      }
    }));
  } catch {}

  session.closeAll();
  await session.settle();
  safeClose(ws);
}
