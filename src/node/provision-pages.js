'use strict';

// The provisioning UI: one operator page for minting invites, three invitee
// pages for redeeming one.
//
// Same invariants as pages.js, and they matter more here because these pages
// render user-chosen labels and hand out credentials:
//   * escapeHtml on every interpolated value;
//   * no innerHTML anywhere — the QR is drawn with fillRect, and every dynamic
//     string reaches the DOM through textContent;
//   * nothing derived from a secret is ever rendered except the one credential
//     the invitee is entitled to.

const { escapeHtml } = require('./pages.js');

const PICO = 'https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css';

// The static, unminified npm artifact — NOT the .min.js, which jsDelivr
// generates on the fly and explicitly warns against pinning with SRI. This file
// is immutable, so the hash is stable.
//
// Recompute with:
//   curl -sS <src> | openssl dgst -sha384 -binary | openssl base64 -A
const QR_SRC = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const QR_SRI = 'sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k';

/**
 * Draw a QR onto a canvas from an element's textContent, and wire the copy
 * button. Shared by the two pages that show a scannable code.
 *
 * A blocked CDN and a failed SRI check land in the same state, and one branch
 * covers both — the link below the canvas is never conditional on the QR, which
 * matters because an invitee is often on exactly the filtered network that
 * might block jsDelivr.
 */
const QR_CLIENT_JS = `
window.addEventListener('load', function () {
  var canvas = document.getElementById('qr');
  var source = document.getElementById('qr-data');
  var note = document.getElementById('qr-note');
  if (!canvas || !source) return;

  var text = source.textContent;
  if (typeof window.qrcode !== 'function') {
    canvas.hidden = true; if (note) note.hidden = false;
    return;
  }
  try {
    var qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount();
    var scale = Math.max(2, Math.floor(canvas.width / (n + 2)));
    var pad = scale;
    canvas.width = canvas.height = n * scale + pad * 2;
    var ctx = canvas.getContext('2d');
    // Always a white quiet zone, whatever the page theme: scanners need it.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000000';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(pad + c * scale, pad + r * scale, scale, scale);
      }
    }
  } catch (e) {
    canvas.hidden = true; if (note) note.hidden = false;
  }
});

`;

/**
 * Wire every <button data-copy="ID"> to the text of the element with that id.
 *
 * Split from QR_CLIENT_JS because the reveal page needs copy without a canvas —
 * keeping them fused would pull a jsDelivr <script> onto a page that draws
 * nothing. Generic over buttons so several can coexist.
 */
const COPY_CLIENT_JS = `
window.addEventListener('load', function () {
  var buttons = document.querySelectorAll('[data-copy]');
  for (var i = 0; i < buttons.length; i++) (function (btn) {
    var source = document.getElementById(btn.getAttribute('data-copy'));
    if (!source) return;
    var label = btn.textContent;
    btn.addEventListener('click', function () {
      function selectIt() {
        // selectNodeContents cannot reach display:none text, so reveal any
        // collapsed <details> around it first.
        var d = source.closest ? source.closest('details') : null;
        if (d) d.open = true;
        var range = document.createRange();
        range.selectNodeContents(source);
        var sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        btn.textContent = 'Selected \\u2014 long-press to copy';
      }
      // navigator.clipboard needs a secure context; selection is the fallback.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(source.textContent).then(function () {
          btn.textContent = 'Copied';
          setTimeout(function () { btn.textContent = label; }, 2000);
        }, selectIt);
      } else {
        selectIt();
      }
    });
  })(buttons[i]);
});
`;

const STYLE = `
        .qr-wrap { text-align: center; }
        #qr { max-width: 100%; height: auto; border-radius: 8px; }
        #qr-data, #conf-json {
            display: block; overflow-wrap: anywhere; user-select: all;
            padding: .6rem; font-size: .8rem;
        }
        #conf-json { max-height: 14rem; overflow: auto; white-space: pre-wrap; }
        .warn { border-left: 4px solid var(--pico-del-color, #c33); padding-left: 1rem; }
`;

/**
 * Shared document shell. `qr` pulls in the CDN script and the canvas wiring and
 * implies `copy`; `copy` alone adds only the (dependency-free) copy wiring.
 */
function page({ title, body, qr = false, copy = false }) {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <meta name="referrer" content="no-referrer">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="${PICO}">
    <style>${STYLE}</style>
${qr ? `    <script src="${QR_SRC}" integrity="${QR_SRI}" crossorigin="anonymous"></script>` : ''}
</head>
<body>
    <main class="container">
${body}
    </main>
${qr ? `    <script>${QR_CLIENT_JS}</script>` : ''}
${qr || copy ? `    <script>${COPY_CLIENT_JS}</script>` : ''}
</body>
</html>`;
}

/** A scannable block: canvas, the raw text, a copy button, and a CDN-failed note. */
function qrBlock(text) {
  return `
        <div class="qr-wrap">
            <canvas id="qr" width="288" height="288"></canvas>
            <p id="qr-note" hidden><small>QR unavailable &mdash; use the link below instead.</small></p>
        </div>
        <code id="qr-data">${escapeHtml(text)}</code>
        <button data-copy="qr-data" class="secondary">Copy link</button>`;
}

// ==========================================
// Operator side
// ==========================================

function renderProvisionPage({ labels, minted = null, publicHost = '', adminPath, nav = '' }) {
  const options = labels.length === 0
    ? '<option value="" disabled selected>No users configured</option>'
    : labels.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('\n                ');

  const hostWarning = publicHost ? '' : `
        <article class="warn">
            <strong>PUBLIC_HOST is not set.</strong> Generated configs fall back to the
            Host header of this request, which may not be the address your users
            can reach. Set it before handing out an invite.
        </article>`;

  const mintedBlock = minted ? `
        <article>
            <hgroup>
                <h2>Invite for ${escapeHtml(minted.label)}</h2>
                <p>Expires ${escapeHtml(minted.expiresAt)} &mdash; scan or send it before then.</p>
                <p><small>UDP policy: <strong>${minted.udp ? 'QUIC tunnelled too' : 'QUIC blocked (default)'}</strong>
                &mdash; downloads as <code>vless-${escapeHtml(minted.label)}${minted.udp ? '-udp' : ''}.json</code></small></p>
            </hgroup>
${qrBlock(minted.url)}
            <p class="warn"><small>Anyone who opens this link before it expires gets
            ${escapeHtml(minted.label)}'s credential. Send it over a private channel.</small></p>
        </article>` : '';

  const emptyNote = labels.length === 0 ? `
        <p><small>Set the <code>USERS</code> secret to a comma-separated list of labels,
        then redeploy. Labels may contain letters, digits, <code>-</code> and <code>_</code>.</small></p>` : '';

  return page({
    title: 'Provision a device',
    qr: Boolean(minted),
    body: `${nav}
        <hgroup>
            <h1>Provision a device</h1>
            <p>Mint a short-lived invite link for one configured user.</p>
        </hgroup>
${hostWarning}
        <form method="get" action="${escapeHtml(adminPath)}">
            <label for="label">User</label>
            <select id="label" name="label" required>
                ${options}
            </select>
            <label for="udp">
                <input type="checkbox" id="udp" name="udp" value="1">
                Tunnel QUIC as well
            </label>
            <small>For comparing. The default blocks QUIC so browsers stay on
            TCP/TLS; ordinary UDP &mdash; games, voice chat &mdash; is tunnelled
            either way.</small>
            <button type="submit"${labels.length === 0 ? ' disabled' : ''}>Create invite</button>
        </form>
${emptyNote}
${mintedBlock}
`
  });
}

// ==========================================
// Invitee side
// ==========================================

/**
 * The landing page. Deliberately carries NO credential and burns nothing:
 * chat apps fetch a pasted URL to build a preview, and burning here would kill
 * the invite before the human ever taps it.
 */
function renderInvitePage({ showUrl }) {
  return page({
    title: 'Your connection',
    body: `        <hgroup>
            <h1>Your connection is ready</h1>
            <p>Tap below to get the settings for your device.</p>
        </hgroup>
        <p><a href="${escapeHtml(showUrl)}" role="button">Get my configuration</a></p>
        <p><small>This link works once, for a few minutes. If it has stopped working,
        ask for a new one.</small></p>`
  });
}

/** The reveal page: this is the one that actually hands over a credential. */
function renderRevealPage({ label, confUrl, configJson }) {
  return page({
    title: 'Your connection',
    copy: true,
    body: `        <hgroup>
            <h1>Set up ${escapeHtml(label)}</h1>
            <p>Install a client first &mdash; v2rayNG, Streisand, Hiddify or NekoBox.</p>
        </hgroup>

        <article>
            <h2>Your configuration</h2>
            <p>Import it as a <strong>Custom config</strong>. It carries the certificate
            a TLS-inspecting network requires, and works on ordinary networks too.</p>
            <p>
                <a href="${escapeHtml(confUrl)}" role="button" class="secondary">Download</a>
                <button data-copy="conf-json" class="secondary outline">Copy configuration</button>
            </p>
            <details>
                <summary><small>Show configuration</small></summary>
                <code id="conf-json">${escapeHtml(configJson)}</code>
            </details>
            <p><small>Games and voice chat work with this file.</small></p>
        </article>

        <p><small>This page stops working in a few minutes.</small></p>`
  });
}

/**
 * One wording for expired, revoked and already-used.
 *
 * Distinguishing them would confirm which labels once existed, and "already
 * used" would be a promise this design cannot keep — the burn set is per
 * process and does not survive a restart.
 */
function renderStalePage() {
  return page({
    title: 'Link expired',
    body: `        <hgroup>
            <h1>This link is no longer valid</h1>
            <p>Ask whoever sent it for a new one.</p>
        </hgroup>`
  });
}

module.exports = {
  renderProvisionPage,
  renderInvitePage,
  renderRevealPage,
  renderStalePage,
  QR_SRC,
  QR_SRI
};
