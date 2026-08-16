'use strict';

// HTML the Node build serves: the decoy cover page and the admin dashboard.
//
// renderStatsPage() is pure — it takes a snapshot (see stats.js) rather than
// reaching for live counters, so the dashboard can be rendered and asserted on
// without a running server.
//
// The dashboard updates over Server-Sent Events (see #serveAdminStream in
// session.js), not by reloading itself. Two rules keep that safe:
//
//   * Scalars are rendered server-side and overwritten client-side on the SAME
//     node, so the markup is defined once. Table rows are rendered ONLY by the
//     client, seeded from an embedded JSON snapshot, so those are defined once
//     too.
//   * Every value that originates from a snapshot reaches the DOM through
//     textContent. `innerHTML` appears nowhere in the client script, and
//     escapeHtml is deliberately NOT reimplemented there — the DOM API is safe
//     by construction, and mixing the two produces double-escaped output.

const { FAKE_INDEX_HTML } = require('../decoy.js');

const PICO = 'https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css';

/**
 * Escape text for HTML interpolation.
 *
 * The dashboard prints connection targets, and a target hostname is chosen by
 * whoever is using the tunnel — so it is attacker-controlled text landing in
 * the operator's page. Without this it is stored XSS on /admin-stats.
 */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serialise for embedding inside a <script> block.
 *
 * JSON.stringify does NOT escape '<', so a hostile lastHost containing
 * "</script>" would break straight out of the block — the same stored XSS
 * escapeHtml prevents on the text path, through a different door. < is a
 * valid JSON escape, so JSON.parse round-trips the original bytes exactly.
 *
 * U+2028/U+2029 are legal in JSON but terminate a line in a JS source literal.
 */
// Built by code point rather than written literally: U+2028/U+2029 are
// invisible in an editor and easy to mangle in transit.
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(LINE_SEP).join('\\u2028')
    .split(PARA_SEP).join('\\u2029');
}

// ==========================================
// Formatters
//
// These two are inlined verbatim into the client script via .toString(), so
// that the server's first render and every subsequent SSE patch format
// identically — otherwise the first event visibly rewrites "2.00 MB" into
// something slightly different.
//
// They must therefore stay closure-free and dependency-free: no captured
// variables, no require, no other helpers. A guard test in test/pages.test.js
// checks the inlined copy still agrees with this one.
// ==========================================

/** hh:mm:ss for a whole number of seconds. */
function formatDuration(seconds) {
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = seconds % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/** Bytes as megabytes, two decimal places. */
function formatMb(bytes) {
  return (bytes / 1048576).toFixed(2) + ' MB';
}

// ==========================================
// Dashboard
// ==========================================

// Pico's .grid is repeat(auto-fit, minmax(0,1fr)), which would put all eleven
// cards on one row. Everything else is Pico's.
const STATS_STYLE = `
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 1rem; }
        .stats article { margin: 0; padding: 1rem; text-align: center; }
        .stats strong { display: block; font-size: 1.6rem; line-height: 1.2; overflow-wrap: anywhere; }
        .stats small { color: var(--pico-muted-color); text-transform: uppercase; letter-spacing: .04em; }
        .tables { overflow-x: auto; }
        #s-link { font-variant: small-caps; }
`;

// Order matters only for layout; the keys are what the client patches.
const CARDS = [
  { key: 'activeConnections', label: 'Active Tunnels' },
  { key: 'totalConnections', label: 'Total Tunnels' },
  { key: 'activeStreams', label: 'Active Streams' },
  { key: 'totalStreams', label: 'Total Streams' },
  // tcpStreams/udpStreams are decremented in endStream, so they are CURRENT
  // counts; muxSessions is monotonic. Labelled apart because rendering all
  // three as bare numbers would quietly mislead.
  { key: 'tcpStreams', label: 'TCP Streams (now)' },
  { key: 'udpStreams', label: 'UDP Streams (now)' },
  { key: 'muxSessions', label: 'Mux Sessions (total)' },
  { key: 'totalBytesTx', label: 'Sent', format: formatMb },
  { key: 'totalBytesRx', label: 'Received', format: formatMb },
  { key: 'uptimeSeconds', label: 'Uptime', format: formatDuration }
];

const TABLE_HEAD = `
                <thead>
                    <tr>
                        <th scope="col">ID</th>
                        <th scope="col">Status</th>
                        <th scope="col">Duration</th>
                        <th scope="col">Streams</th>
                        <th scope="col">Target</th>
                        <th scope="col">Protocol</th>
                    </tr>
                </thead>`;

function renderCards(snapshot, wsPath) {
  const cards = CARDS.map(({ key, label, format }) => {
    const raw = snapshot[key];
    const value = format ? format(raw) : raw;
    return `
            <article data-stat="${key}">
                <strong id="s-${key}">${escapeHtml(value)}</strong>
                <small>${label}</small>
            </article>`;
  });

  // wsPath is a config value, not a snapshot field, so the client never
  // patches it — but it is still interpolated text and still gets escaped.
  cards.push(`
            <article data-stat="wsPath">
                <strong id="s-wsPath">${escapeHtml(wsPath)}</strong>
                <small>WS Path</small>
            </article>`);

  return cards.join('');
}

// Client script. Plain concatenation throughout — no nested template literals,
// since this whole file is itself a template literal.
const CLIENT_JS = `
(function () {
  function $(id) { return document.getElementById(id); }

  function put(key, text) {
    var el = $('s-' + key);
    if (el) el.textContent = text;
  }

  function rows(tbody, list, isActive) {
    if (!tbody) return;
    tbody.replaceChildren();

    if (!list || !list.length) {
      var empty = document.createElement('tr');
      var cell = document.createElement('td');
      cell.colSpan = 6;
      cell.textContent = isActive ? 'No active connections' : 'No connection history';
      empty.appendChild(cell);
      tbody.appendChild(empty);
      return;
    }

    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var tr = document.createElement('tr');
      var cells = [
        '#' + c.id,
        isActive ? 'Active' : 'Closed',
        formatDuration(c.durationSeconds),
        String(c.streams || 0),
        c.lastHost || '-',
        c.lastProto || '-'
      ];
      for (var j = 0; j < cells.length; j++) {
        var td = document.createElement('td');
        td.textContent = cells[j];   // the ONLY place snapshot data enters the DOM
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  function apply(s) {
    put('activeConnections', s.activeConnections);
    put('totalConnections', s.totalConnections);
    put('activeStreams', s.activeStreams);
    put('totalStreams', s.totalStreams);
    put('tcpStreams', s.tcpStreams);
    put('udpStreams', s.udpStreams);
    put('muxSessions', s.muxSessions);
    put('totalBytesTx', formatMb(s.totalBytesTx));
    put('totalBytesRx', formatMb(s.totalBytesRx));
    put('uptimeSeconds', formatDuration(s.uptimeSeconds));
    rows($('active-rows'), s.active, true);
    rows($('history-rows'), s.history, false);
  }

  var seed = $('snapshot');
  if (seed) { try { apply(JSON.parse(seed.textContent)); } catch (e) { /* keep the shell */ } }

  // Same path plus the same query string, so the token is carried across
  // automatically and never has to be interpolated into this script — which
  // would be a second place to get escaping wrong.
  var es = new EventSource(location.pathname + '/stream' + location.search);
  es.onmessage = function (e) { try { apply(JSON.parse(e.data)); } catch (err) { /* skip */ } };
  es.onopen = function () { put('link', 'live'); };
  es.onerror = function () { put('link', 'reconnecting'); };
})();
`;

/**
 * Render the admin dashboard from a stats snapshot.
 *
 * @param {object} snapshot - see createStats().snapshot() in stats.js
 * @param {string} wsPath   - shown so the operator can confirm the live path
 */
function renderStatsPage(snapshot, wsPath) {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <title>Server Statistics</title>
    <link rel="stylesheet" href="${PICO}">
    <style>${STATS_STYLE}</style>
</head>
<body>
    <main class="container">
        <hgroup>
            <h1>Server Statistics Dashboard</h1>
            <p>Live monitoring of all connections and traffic &mdash; <span id="s-link">connecting</span></p>
        </hgroup>

        <section class="stats">${renderCards(snapshot, wsPath)}
        </section>

        <section>
            <h2>Active Connections</h2>
            <div class="tables">
                <table>${TABLE_HEAD}
                    <tbody id="active-rows"></tbody>
                </table>
            </div>
        </section>

        <section>
            <h2>Recent Connection History</h2>
            <div class="tables">
                <table>${TABLE_HEAD}
                    <tbody id="history-rows"></tbody>
                </table>
            </div>
        </section>
    </main>
    <script type="application/json" id="snapshot">${embedJson(snapshot)}</script>
    <script>
${formatDuration.toString()}
${formatMb.toString()}
${CLIENT_JS}
    </script>
</body>
</html>`;
}

module.exports = {
  FAKE_INDEX_HTML,
  renderStatsPage,
  escapeHtml,
  embedJson,
  formatDuration,
  formatMb
};
