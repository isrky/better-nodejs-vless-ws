'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FAKE_INDEX_HTML, renderStatsPage, escapeHtml, embedJson, formatDuration, formatMb
} = require('../src/node/pages.js');
const decoy = require('../src/decoy.js');

const EXPECTED_STAT_KEYS = [
  'activeConnections', 'totalConnections', 'activeStreams', 'totalStreams',
  'tcpStreams', 'udpStreams', 'muxSessions',
  'totalBytesTx', 'totalBytesRx', 'uptimeSeconds', 'wsPath'
];

function snapshot(over = {}) {
  return {
    uptimeSeconds: 3661,
    totalConnections: 5,
    activeConnections: 2,
    totalStreams: 9,
    activeStreams: 3,
    totalBytesTx: 1024 * 1024 * 2,
    totalBytesRx: 1024 * 1024 * 3,
    tcpStreams: 3,
    udpStreams: 1,
    muxSessions: 2,
    active: [],
    history: [],
    ...over
  };
}

/** Pull the snapshot the client is seeded from back out of the page. */
function parseEmbedded(html) {
  const m = html.match(/<script type="application\/json" id="snapshot">([\s\S]*?)<\/script>/);
  assert.ok(m, 'the page must embed a seed snapshot');
  return JSON.parse(m[1]);
}

test('formatDuration renders hh:mm:ss', () => {
  assert.equal(formatDuration(0), '00:00:00');
  assert.equal(formatDuration(59), '00:00:59');
  assert.equal(formatDuration(3661), '01:01:01');
  assert.equal(formatDuration(360000), '100:00:00');
});

test('formatMb renders megabytes to two places', () => {
  assert.equal(formatMb(0), '0.00 MB');
  assert.equal(formatMb(1048576), '1.00 MB');
  assert.equal(formatMb(1024 * 1024 * 2.5), '2.50 MB');
});

test('renderStatsPage is pure and renders every stat card', () => {
  const html = renderStatsPage(snapshot(), '/tunnel');

  const keys = [...html.matchAll(/data-stat="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys.slice().sort(), EXPECTED_STAT_KEYS.slice().sort());

  assert.match(html, /01:01:01/, 'uptime');
  assert.match(html, /2\.00 MB/, 'MB sent');
  assert.match(html, /3\.00 MB/, 'MB received');
  assert.match(html, />\/tunnel</, 'ws path');

  // Same input, same output — no hidden state.
  assert.equal(renderStatsPage(snapshot(), '/tunnel'), html);
});

test('renderStatsPage surfaces the per-protocol counters', () => {
  const html = renderStatsPage(snapshot(), '/');
  for (const key of ['tcpStreams', 'udpStreams', 'muxSessions']) {
    assert.match(html, new RegExp(`id="s-${key}"`), key);
  }
  // Labelled apart because tcp/udp are current counts and mux is cumulative.
  assert.match(html, /TCP Streams \(now\)/);
  assert.match(html, /Mux Sessions \(total\)/);
});

test('the seed snapshot carries the rows the client renders', () => {
  const active = [{ id: 1, durationSeconds: 65, streams: 2, lastHost: 'example.com:443', lastProto: 'TCP' }];
  const history = [{ id: 2, durationSeconds: 5, streams: 1, lastHost: '1.1.1.1:53', lastProto: 'UDP' }];

  const seeded = parseEmbedded(renderStatsPage(snapshot({ active, history }), '/'));
  assert.deepEqual(seeded.active, active);
  assert.deepEqual(seeded.history, history);
});

test('the seed snapshot is empty when there is no traffic', () => {
  const seeded = parseEmbedded(renderStatsPage(snapshot(), '/'));
  assert.deepEqual(seeded.active, []);
  assert.deepEqual(seeded.history, []);
});

test('the dashboard no longer reloads itself', () => {
  const html = renderStatsPage(snapshot(), '/');
  assert.ok(!html.includes('location.reload'), 'the 5s reload loop must be gone');
  assert.match(html, /new EventSource\(/, 'replaced by a stats stream');
});

test('the client never writes snapshot data through innerHTML', () => {
  // textContent is safe by construction; innerHTML would reintroduce the XSS
  // escapeHtml prevents on the server side.
  const html = renderStatsPage(snapshot(), '/');
  assert.ok(!html.includes('innerHTML'));
  assert.match(html, /textContent/);
});

test('escapeHtml neutralises the HTML metacharacters', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('a&b'), 'a&amp;b');
  assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
  assert.equal(escapeHtml("it's"), 'it&#39;s');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('embedJson escapes what would break out of a script block', () => {
  assert.ok(!embedJson({ a: '</script>' }).includes('</script>'));
  assert.ok(!embedJson({ a: '<b>' }).includes('<'));
  assert.ok(!embedJson({ a: '<b>' }).includes('>'));
  assert.ok(!embedJson({ a: 'x&y' }).includes('&'));

  // U+2028/U+2029 are valid JSON but terminate a line in a JS source literal.
  const seps = String.fromCharCode(0x2028) + String.fromCharCode(0x2029);
  const encoded = embedJson({ a: seps });
  assert.ok(!encoded.includes(String.fromCharCode(0x2028)));
  assert.ok(!encoded.includes(String.fromCharCode(0x2029)));

  // The escaping must be lossless, not merely destructive.
  for (const value of ['</script>', '<b>', 'x&y', seps, 'plain', 'héllo — münchen']) {
    assert.equal(JSON.parse(embedJson({ a: value })).a, value);
  }
});

test('a hostile destination hostname cannot break out of the seed script', () => {
  // lastHost comes from the tunnel destination, i.e. from whoever is using the
  // proxy. This is the stored-XSS case, now via the JSON block rather than the
  // text path.
  const payload = '</script><script>alert(1)</script>';
  const html = renderStatsPage(snapshot({
    active: [{ id: 1, durationSeconds: 1, streams: 1, lastHost: payload, lastProto: payload }]
  }), '/');

  assert.ok(!html.includes('</script><script>alert'), 'raw breakout must not survive');
  assert.equal(parseEmbedded(html).active[0].lastHost, payload, 'and must round-trip intact');
});

test('the ws path cannot inject markup', () => {
  const html = renderStatsPage(snapshot(), '/"><script>x</script>');
  assert.ok(!html.includes('<script>x</script>'));
});

test('the inlined formatters still match the server implementations', () => {
  // formatDuration and formatMb are shipped to the browser via .toString(), so
  // the initial render and the SSE patch cannot format differently. That breaks
  // silently if either ever gains a closure dependency — this is the guard.
  const html = renderStatsPage(snapshot(), '/');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const src = scripts.find((s) => s.includes('function formatDuration'));
  assert.ok(src, 'the page must inline the formatters');

  const inlined = new Function(`${src.split('(function ()')[0]}
    return { formatDuration: formatDuration, formatMb: formatMb };`)();

  for (const s of [0, 59, 3661, 360000]) {
    assert.equal(inlined.formatDuration(s), formatDuration(s), `formatDuration(${s})`);
  }
  for (const b of [0, 1048576, 123456789]) {
    assert.equal(inlined.formatMb(b), formatMb(b), `formatMb(${b})`);
  }
});

test('the decoy page is byte-identical across the Node and Worker builds', async () => {
  const worker = await import('../src/worker/pages.mjs');
  assert.equal(FAKE_INDEX_HTML, decoy.FAKE_INDEX_HTML);
  assert.equal(worker.FAKE_INDEX_HTML, decoy.FAKE_INDEX_HTML,
    'both builds must serve the same cover site');
});

test('the decoy page stays a plain cover site', () => {
  // No forms, no analytics, and exactly one external origin (the CSS CDN).
  assert.ok(!/<form/i.test(FAKE_INDEX_HTML));
  const origins = [...FAKE_INDEX_HTML.matchAll(/https?:\/\/([^/"']+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(origins)], ['cdn.jsdelivr.net']);
});
