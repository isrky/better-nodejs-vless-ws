'use strict';

// Accounting must round-trip to zero. Teardown is reachable from the client
// socket, the target socket and each mux substream, so the guard against
// double-counting is what keeps the dashboard from drifting negative over a
// long uptime.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStats, MAX_HISTORY, HISTORY_SHOWN } = require('../src/node/stats.js');

test('connections open and close back to zero', () => {
  const stats = createStats();
  const a = stats.openConnection();
  const b = stats.openConnection();

  assert.equal(stats.snapshot().activeConnections, 2);
  assert.equal(stats.snapshot().totalConnections, 2);
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);

  stats.closeConnection(a);
  stats.closeConnection(b);

  const s = stats.snapshot();
  assert.equal(s.activeConnections, 0);
  assert.equal(s.totalConnections, 2, 'totals are cumulative');
  assert.equal(s.active.length, 0);
});

test('closeConnection is idempotent', () => {
  const stats = createStats();
  const conn = stats.openConnection();

  stats.closeConnection(conn);
  stats.closeConnection(conn);
  stats.closeConnection(conn);

  const s = stats.snapshot();
  assert.equal(s.activeConnections, 0, 'must not go negative');
  assert.equal(s.history.length, 1, 'and must not be recorded twice');
});

test('endStream is idempotent, so a mux teardown cannot double-count', () => {
  const stats = createStats();
  const conn = stats.openConnection();

  const records = [];
  for (let i = 0; i < 5; i++) records.push(stats.startStream(conn, 'TCP', 'h', 80));
  assert.equal(stats.snapshot().activeStreams, 5);

  // Close everything twice, as an id present in both the TCP and UDP maps
  // would have been.
  for (const r of records) stats.endStream(r);
  for (const r of records) stats.endStream(r);

  const s = stats.snapshot();
  assert.equal(s.activeStreams, 0);
  assert.equal(s.tcpStreams, 0);
  assert.equal(s.totalStreams, 5);
});

test('streams are counted per protocol', () => {
  const stats = createStats();
  const conn = stats.openConnection();

  const tcp = stats.startStream(conn, 'TCP', 'a', 1);
  const udp = stats.startStream(conn, 'UDP', 'b', 2);

  let s = stats.snapshot();
  assert.equal(s.tcpStreams, 1);
  assert.equal(s.udpStreams, 1);
  assert.equal(s.activeStreams, 2);

  stats.endStream(tcp);
  stats.endStream(udp);

  s = stats.snapshot();
  assert.equal(s.tcpStreams, 0);
  assert.equal(s.udpStreams, 0);
  assert.equal(s.activeStreams, 0);
});

test('startStream records the latest target on the connection', () => {
  const stats = createStats();
  const conn = stats.openConnection();

  stats.startStream(conn, 'TCP', 'first.example', 80);
  stats.startStream(conn, 'UDP', 'second.example', 53);

  const [active] = stats.snapshot().active;
  assert.equal(active.lastHost, 'second.example:53');
  assert.equal(active.lastProto, 'UDP');
  assert.equal(active.streams, 2);
});

test('byte counters accumulate on both the stream and the totals', () => {
  const stats = createStats();
  const conn = stats.openConnection();
  const record = stats.startStream(conn, 'TCP', 'h', 80);

  stats.addTx(conn, record, 100);
  stats.addTx(conn, record, 50);
  stats.addRx(conn, record, 200);
  stats.addRx(conn, record, undefined);   // tolerated, counts as zero

  const s = stats.snapshot();
  assert.equal(s.totalBytesTx, 150);
  assert.equal(s.totalBytesRx, 200);
  assert.equal(record.txBytes, 150);
  assert.equal(conn.bytesRx, 200);
});

test('history is capped and returned newest first', () => {
  const stats = createStats();

  for (let i = 0; i < MAX_HISTORY + 40; i++) {
    stats.closeConnection(stats.openConnection());
  }

  const s = stats.snapshot();
  assert.equal(s.activeConnections, 0);
  assert.equal(s.history.length, HISTORY_SHOWN, 'the dashboard shows a window');
  assert.ok(s.history[0].id > s.history[1].id, 'newest first');
  assert.equal(s.history[0].id, MAX_HISTORY + 40);
});

test('two collectors do not share counters', () => {
  const a = createStats();
  const b = createStats();

  a.openConnection();
  a.openConnection();

  assert.equal(a.snapshot().totalConnections, 2);
  assert.equal(b.snapshot().totalConnections, 0);
  assert.equal(b.openConnection().id, 1, 'ids restart per collector');
});

test('durations use a monotonic injected clock', () => {
  let t = 1_000_000;
  const stats = createStats(() => t);

  const conn = stats.openConnection();
  t += 65_000;
  assert.equal(stats.snapshot().active[0].durationSeconds, 65);

  stats.closeConnection(conn);
  t += 999_000;
  assert.equal(stats.snapshot().history[0].durationSeconds, 65,
    'a closed connection freezes its duration');
});
