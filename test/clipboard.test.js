'use strict';

// writeClipboard's mechanism selection: a local binary only when a display is
// present, OSC 52 otherwise (or on spawn failure). Everything is injected so
// the test never spawns a process or emits a real escape.

const test = require('node:test');
const assert = require('node:assert/strict');

let clip;

test.before(async () => {
  clip = await import('../tools/clipboard.mjs');
});

function fakeStdout() {
  const writes = [];
  return { writes, write: (s) => writes.push(s) };
}

// Decode the payload of an OSC 52 frame: ESC ] 52 ; c ; <base64> BEL
function osc52Payload(frame) {
  const m = /^\x1b\]52;c;([^\x07]*)\x07$/.exec(frame);
  assert.ok(m, `not an OSC 52 frame: ${JSON.stringify(frame)}`);
  return Buffer.from(m[1], 'base64').toString('utf8');
}

test('uses wl-copy under Wayland and pipes the text to its stdin', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, input: opts.input }); return { status: 0 }; };
  const stdout = fakeStdout();
  const method = clip.writeClipboard('K=v\n', {
    env: { WAYLAND_DISPLAY: 'wayland-1' }, platform: 'linux', stdout, spawn
  });

  assert.equal(method, 'wl-copy');
  assert.deepEqual(calls, [{ cmd: 'wl-copy', args: [], input: 'K=v\n' }]);
  assert.equal(stdout.writes.length, 0, 'no OSC 52 escape when the binary succeeds');
});

test('uses xclip under X11', () => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, input: opts.input }); return { status: 0 }; };
  const method = clip.writeClipboard('K=v\n', {
    env: { DISPLAY: ':0' }, platform: 'linux', stdout: fakeStdout(), spawn
  });

  assert.equal(method, 'xclip');
  assert.deepEqual(calls[0], { cmd: 'xclip', args: ['-selection', 'clipboard'], input: 'K=v\n' });
});

test('uses pbcopy on darwin', () => {
  const spawn = () => ({ status: 0 });
  assert.equal(clip.writeClipboard('x', { env: {}, platform: 'darwin', stdout: fakeStdout(), spawn }), 'pbcopy');
});

test('falls back to OSC 52 with no display (the SSH-to-headless case)', () => {
  let spawned = false;
  const spawn = () => { spawned = true; return { status: 0 }; };
  const stdout = fakeStdout();
  const method = clip.writeClipboard('SECRETS_KEY_COMMON=abc\n', {
    env: {}, platform: 'linux', stdout, spawn
  });

  assert.equal(method, 'osc52');
  assert.equal(spawned, false, 'no binary is spawned without a display');
  assert.equal(stdout.writes.length, 1);
  assert.equal(osc52Payload(stdout.writes[0]), 'SECRETS_KEY_COMMON=abc\n');
});

test('falls back to OSC 52 when the local binary errors or exits non-zero', () => {
  const stdout = fakeStdout();
  const errored = clip.writeClipboard('x\n', {
    env: { WAYLAND_DISPLAY: 'wayland-1' }, platform: 'linux', stdout,
    spawn: () => ({ error: new Error('ENOENT') })
  });
  assert.equal(errored, 'osc52');

  const stdout2 = fakeStdout();
  const nonzero = clip.writeClipboard('y\n', {
    env: { DISPLAY: ':0' }, platform: 'linux', stdout: stdout2,
    spawn: () => ({ status: 1 })
  });
  assert.equal(nonzero, 'osc52');
  assert.equal(osc52Payload(stdout2.writes[0]), 'y\n');
});
