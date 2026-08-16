'use strict';

// Traffic and connection accounting for the admin dashboard.
//
// Instance state, not module state: two servers in one process (which is what
// the test suite does) must not share counters, and snapshot() has to be
// reproducible.
//
// The counters are updated from a single thread with no await between
// read and write, so they need no locking.

// How many closed connections to retain for the history table.
const MAX_HISTORY = 100;

// How many of them the dashboard shows, newest first.
const HISTORY_SHOWN = 20;

function createStats(now = Date.now) {
  const startTime = now();

  let connectionCounter = 0;

  const totals = {
    totalConnections: 0,
    activeConnections: 0,
    totalStreams: 0,
    activeStreams: 0,
    totalBytesTx: 0,
    totalBytesRx: 0,
    tcpStreams: 0,
    udpStreams: 0,
    muxSessions: 0
  };

  const connections = new Map();
  const history = [];

  /** Register a new client connection and return its mutable record. */
  function openConnection() {
    connectionCounter += 1;
    const info = {
      id: connectionCounter,
      active: true,
      startTime: now(),
      endTime: 0,
      streams: 0,
      lastHost: '',
      lastProto: 'TCP',
      bytesTx: 0,
      bytesRx: 0
    };
    connections.set(info.id, info);
    totals.totalConnections += 1;
    totals.activeConnections += 1;
    return info;
  }

  /**
   * Retire a connection. Idempotent on purpose: teardown is reachable from the
   * client socket, the target socket and each mux substream, and a second call
   * would drive activeConnections negative and make the dashboard drift.
   */
  function closeConnection(info) {
    if (!info || !info.active) return;
    info.active = false;
    info.endTime = now();

    totals.activeConnections -= 1;
    connections.delete(info.id);

    history.push(info);
    if (history.length > MAX_HISTORY) history.shift();
  }

  /**
   * Begin a stream (a direct tunnel or one mux substream) and return a record
   * to hand back to endStream().
   */
  function startStream(info, proto, host, port) {
    const record = { proto, host, port, ended: false, startTime: now(), txBytes: 0, rxBytes: 0 };

    if (info) {
      info.streams += 1;
      info.lastHost = `${host}:${port}`;
      info.lastProto = proto;
    }

    totals.totalStreams += 1;
    totals.activeStreams += 1;
    if (proto === 'TCP') totals.tcpStreams += 1;
    else if (proto === 'UDP') totals.udpStreams += 1;

    return record;
  }

  /** End a stream. Idempotent — see closeConnection(). */
  function endStream(record) {
    if (!record || record.ended) return;
    record.ended = true;

    totals.activeStreams -= 1;
    if (record.proto === 'TCP') totals.tcpStreams -= 1;
    else if (record.proto === 'UDP') totals.udpStreams -= 1;
  }

  function addTx(info, record, bytes) {
    const n = bytes || 0;
    if (record) record.txBytes += n;
    if (info) info.bytesTx += n;
    totals.totalBytesTx += n;
  }

  function addRx(info, record, bytes) {
    const n = bytes || 0;
    if (record) record.rxBytes += n;
    if (info) info.bytesRx += n;
    totals.totalBytesRx += n;
  }

  function noteMuxSession() {
    totals.muxSessions += 1;
  }

  function describe(info, at) {
    return {
      id: info.id,
      durationSeconds: Math.floor(((info.active ? at : info.endTime) - info.startTime) / 1000),
      streams: info.streams,
      lastHost: info.lastHost,
      lastProto: info.lastProto
    };
  }

  /** A plain, render-ready view of the current state. */
  function snapshot() {
    const at = now();
    const active = [];
    for (const info of connections.values()) {
      if (info.active) active.push(describe(info, at));
    }

    const recent = [];
    for (let i = history.length - 1; i >= 0 && recent.length < HISTORY_SHOWN; i--) {
      recent.push(describe(history[i], at));
    }

    return {
      uptimeSeconds: Math.floor((at - startTime) / 1000),
      ...totals,
      active,
      history: recent
    };
  }

  return {
    openConnection,
    closeConnection,
    startStream,
    endStream,
    addTx,
    addRx,
    noteMuxSession,
    snapshot
  };
}

module.exports = { createStats, MAX_HISTORY, HISTORY_SHOWN };
