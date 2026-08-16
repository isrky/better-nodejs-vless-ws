'use strict';

// Timestamped console logger. Deliberately tiny and injectable: createLogger()
// lets tests capture output instead of polluting the runner's stdout.

function createLogger(write = console.log, now = () => new Date()) {
  return function log(level, msg) {
    const t = now();
    const timeStr = `${String(t.getHours()).padStart(2, '0')}:` +
                    `${String(t.getMinutes()).padStart(2, '0')}:` +
                    `${String(t.getSeconds()).padStart(2, '0')}`;
    write(`[${timeStr}][${level}] ${msg}`);
  };
}

const log = createLogger();

module.exports = { log, createLogger };
