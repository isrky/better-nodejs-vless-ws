'use strict';

// HTML the Node build serves: the decoy cover page and the admin dashboard.
//
// renderStatsPage() is pure — it takes a snapshot (see stats.js) rather than
// reaching for live counters, so the dashboard can be rendered and asserted on
// without a running server.

const { FAKE_INDEX_HTML } = require('../decoy.js');

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

/** hh:mm:ss for a whole number of seconds. */
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const STATS_STYLE = `
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: #0f0f23;
            color: #e0e0e0;
            min-height: 100vh;
        }
        .header {
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            padding: 30px;
            text-align: center;
            border-bottom: 2px solid #0f3460;
        }
        .header h1 {
            font-size: 2.2em;
            background: linear-gradient(90deg, #e94560, #0f3460);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 8px;
        }
        .header p { color: #8892b0; font-size: 0.95em; }
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 15px;
            margin-bottom: 25px;
        }
        .stat-card {
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            padding: 20px;
            border-radius: 12px;
            border: 1px solid #0f3460;
            text-align: center;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        .stat-card:hover {
            transform: translateY(-3px);
            box-shadow: 0 8px 25px rgba(233, 69, 96, 0.15);
        }
        .stat-card .icon {
            font-size: 2em;
            margin-bottom: 10px;
        }
        .stat-card .value {
            font-size: 2em;
            font-weight: 700;
            color: #e94560;
            margin: 5px 0;
        }
        .stat-card .label {
            color: #8892b0;
            font-size: 0.85em;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .section {
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            border-radius: 12px;
            border: 1px solid #0f3460;
            margin-bottom: 20px;
            overflow: hidden;
        }
        .section-header {
            padding: 15px 20px;
            background: rgba(15, 52, 96, 0.5);
            border-bottom: 1px solid #0f3460;
            font-size: 1.1em;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .section-body { padding: 0; }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th, td {
            padding: 12px 15px;
            text-align: left;
            border-bottom: 1px solid #0f3460;
        }
        th {
            background: rgba(15, 52, 96, 0.3);
            color: #e94560;
            font-weight: 600;
            text-transform: uppercase;
            font-size: 0.8em;
            letter-spacing: 1px;
        }
        td { color: #ccd6f6; font-size: 0.9em; }
        tr:hover td { background: rgba(233, 69, 96, 0.05); }
        .badge {
            display: inline-block;
            padding: 3px 10px;
            border-radius: 20px;
            font-size: 0.75em;
            font-weight: 600;
            text-transform: uppercase;
        }
        .badge-tcp { background: rgba(46, 213, 115, 0.2); color: #2ed573; }
        .badge-udp { background: rgba(30, 144, 255, 0.2); color: #1e90ff; }
        .badge-mux { background: rgba(255, 165, 2, 0.2); color: #ffa502; }
        .badge-active { background: rgba(46, 213, 115, 0.2); color: #2ed573; }
        .badge-inactive { background: rgba(255, 71, 87, 0.2); color: #ff4757; }
        .status-dot {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 6px;
            animation: pulse 2s infinite;
        }
        .status-online { background: #2ed573; }
        .status-offline { background: #ff4757; }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .refresh-bar {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            background: #1a1a2e;
            border-top: 1px solid #0f3460;
            padding: 10px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 0.85em;
        }
        .refresh-btn {
            background: #e94560;
            color: white;
            border: none;
            padding: 8px 20px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.9em;
            transition: background 0.2s;
        }
        .refresh-btn:hover { background: #c73651; }
        .empty-state {
            text-align: center;
            padding: 40px;
            color: #8892b0;
        }
        @media (max-width: 768px) {
            .stats-grid { grid-template-columns: repeat(2, 1fr); }
            .header h1 { font-size: 1.5em; }
        }
    `;

const TABLE_HEAD = `
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Status</th>
                            <th>Duration</th>
                            <th>Streams</th>
                            <th>Target</th>
                            <th>Protocol</th>
                        </tr>
                    </thead>
                    <tbody>
`;

/** One <tr> for a connection record, active or closed. */
function renderRow(conn, active) {
  const dot = active ? 'status-online' : 'status-offline';
  const label = active ? 'Active' : 'Closed';
  // lastProto and lastHost originate from the tunnel's destination, i.e. from
  // the client — escape both.
  const proto = escapeHtml(conn.lastProto || '-');
  const badge = escapeHtml((conn.lastProto || 'tcp').toLowerCase());
  return `
                        <tr>
                            <td>#${Number(conn.id) || 0}</td>
                            <td><span class="status-dot ${dot}"></span>${label}</td>
                            <td>${formatDuration(conn.durationSeconds)}</td>
                            <td>${Number(conn.streams) || 0}</td>
                            <td>${escapeHtml(conn.lastHost || '-')}</td>
                            <td><span class="badge badge-${badge}">${proto}</span></td>
                        </tr>
`;
}

function renderRows(list, active, emptyMessage) {
  if (list.length === 0) {
    return `
                        <tr>
                            <td colspan="6" class="empty-state">${emptyMessage}</td>
                        </tr>
`;
  }
  return list.map((conn) => renderRow(conn, active)).join('');
}

/**
 * Render the admin dashboard from a stats snapshot.
 *
 * @param {object} snapshot - see createStats().snapshot() in stats.js
 * @param {string} wsPath   - shown so the operator can confirm the live path
 */
function renderStatsPage(snapshot, wsPath) {
  const mb = (n) => (n / 1024 / 1024).toFixed(2);

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Server Statistics</title>
    <style>${STATS_STYLE}</style>
    <script>
        setInterval(function() { location.reload(); }, 5000);
    </script>
</head>
<body>
    <div class="header">
        <h1>Server Statistics Dashboard</h1>
        <p>Real-time monitoring of all connections and traffic</p>
    </div>
    <div class="container">
        <div class="stats-grid">
            <div class="stat-card">
                <div class="icon">&#128202;</div>
                <div class="value">${snapshot.totalConnections}</div>
                <div class="label">Total Connections</div>
            </div>
            <div class="stat-card">
                <div class="icon">&#128308;</div>
                <div class="value">${snapshot.activeConnections}</div>
                <div class="label">Active Connections</div>
            </div>
            <div class="stat-card">
                <div class="icon">&#128256;</div>
                <div class="value">${snapshot.totalStreams}</div>
                <div class="label">Total Streams</div>
            </div>
            <div class="stat-card">
                <div class="icon">&#9889;</div>
                <div class="value">${snapshot.activeStreams}</div>
                <div class="label">Active Streams</div>
            </div>
            <div class="stat-card">
                <div class="icon">&#128228;</div>
                <div class="value">${mb(snapshot.totalBytesTx)} MB</div>
                <div class="label">Total Sent</div>
            </div>
            <div class="stat-card">
                <div class="icon">&#128229;</div>
                <div class="value">${mb(snapshot.totalBytesRx)} MB</div>
                <div class="label">Total Received</div>
            </div>
            <div class="stat-card">
                <div class="icon">&#128336;</div>
                <div class="value">${formatDuration(snapshot.uptimeSeconds)}</div>
                <div class="label">Uptime</div>
            </div>
            <div class="stat-card">
                <div class="icon">&#128274;</div>
                <div class="value">${escapeHtml(wsPath)}</div>
                <div class="label">WS Path</div>
            </div>
        </div>
        <div class="section">
            <div class="section-header">
                <span>&#127760;</span>
                <span>Active Connections</span>
            </div>
            <div class="section-body">
                <table>${TABLE_HEAD}${renderRows(snapshot.active, true, 'No active connections')}
                    </tbody>
                </table>
            </div>
        </div>
        <div class="section">
            <div class="section-header">
                <span>&#128220;</span>
                <span>Recent Connection History</span>
            </div>
            <div class="section-body">
                <table>${TABLE_HEAD}${renderRows(snapshot.history, false, 'No connection history')}
                    </tbody>
                </table>
            </div>
        </div>
    </div>
    <div class="refresh-bar">
        <span>Auto-refresh every 5 seconds</span>
        <button class="refresh-btn" onclick="location.reload()">Refresh Now</button>
    </div>
</body>
</html>`;
}

module.exports = { FAKE_INDEX_HTML, renderStatsPage, escapeHtml, formatDuration };
