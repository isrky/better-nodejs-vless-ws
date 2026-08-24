#!/usr/bin/env node
'use strict';

const { startServer } = require('./src/node/server.js');

const handle = startServer();

// Drain on SIGTERM/SIGINT so a Docker stop doesn't hard-cut live tunnels:
// stop accepting, let existing connections finish, and cap the wait — VLESS
// tunnels are long-lived by design, so a full drain may never come on its own.
// The 25s cap stays under compose's stop_grace_period (30s) so Docker never
// escalates to SIGKILL mid-drain. A second signal exits immediately.
const DRAIN_CAP_MS = 25_000;

let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (closing) process.exit(1);
    closing = true;
    console.log(`${signal}: draining (cap ${DRAIN_CAP_MS / 1000}s)`);
    handle.close(() => process.exit(0));
    // unref() so the timer never outlives an early drain; open sockets keep
    // the loop alive, which is exactly when the cap needs to fire.
    setTimeout(() => process.exit(0), DRAIN_CAP_MS).unref();
  });
}
