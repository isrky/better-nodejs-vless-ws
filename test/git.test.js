'use strict';

// The git helper for the push tab. The command runner is injected, so these
// tests never shell out — they record the args git would have been called with
// and simulate its stdout / failures.

const test = require('node:test');
const assert = require('node:assert/strict');

let gh;

test.before(async () => {
  gh = await import('../tools/git.mjs');
});

// Build a run() stub from a map of joined-args → stdout (or an Error to throw).
function fakeRun(responses, calls = []) {
  return async (args) => {
    calls.push(args);
    const key = args.join(' ');
    const value = responses[key];
    if (value instanceof Error) throw value;
    return value ?? '';
  };
}

test('secretsGitStatus reports a clean, up-to-date file', async () => {
  const run = fakeRun({
    'status --porcelain -- src/node/secrets.enc.json': '',
    'rev-parse --abbrev-ref HEAD': 'main\n',
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/main\n',
    'rev-list --left-right --count @{u}...HEAD': '0\t0\n'
  });
  const status = await gh.secretsGitStatus({ run });
  assert.deepEqual(status, { file: 'clean', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 });
});

test('secretsGitStatus reports modified file and ahead/behind counts', async () => {
  const run = fakeRun({
    'status --porcelain -- src/node/secrets.enc.json': ' M src/node/secrets.enc.json\n',
    'rev-parse --abbrev-ref HEAD': 'main\n',
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/main\n',
    'rev-list --left-right --count @{u}...HEAD': '1\t2\n'   // 1 behind, 2 ahead
  });
  const status = await gh.secretsGitStatus({ run });
  assert.equal(status.file, 'modified');
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
});

test('secretsGitStatus reports no upstream when @{u} fails', async () => {
  const run = fakeRun({
    'status --porcelain -- src/node/secrets.enc.json': '',
    'rev-parse --abbrev-ref HEAD': 'feature\n',
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': new Error('no upstream'),
  });
  const status = await gh.secretsGitStatus({ run });
  assert.equal(status.upstream, null);
  assert.equal(status.ahead, 0);
  assert.equal(status.behind, 0);
  assert.equal(status.branch, 'feature');
});

test('gitCommitPush commits only the secrets file when dirty, then pushes', async () => {
  const calls = [];
  const run = fakeRun({ 'status --porcelain -- src/node/secrets.enc.json': ' M src/node/secrets.enc.json\n' }, calls);
  const out = [];
  const result = await gh.gitCommitPush((s) => out.push(String(s)), { run });

  assert.equal(result, true);
  assert.deepEqual(calls, [
    ['status', '--porcelain', '--', 'src/node/secrets.enc.json'],
    ['commit', '-m', 'Update encrypted secrets', '--', 'src/node/secrets.enc.json'],
    ['push']
  ]);
  assert.match(out.join('\n'), /committed src\/node\/secrets\.enc\.json/);
  assert.match(out.join('\n'), /pushed/);
});

test('gitCommitPush skips the commit when the file is clean but still pushes', async () => {
  const calls = [];
  const run = fakeRun({ 'status --porcelain -- src/node/secrets.enc.json': '' }, calls);
  await gh.gitCommitPush(() => {}, { run });
  assert.deepEqual(calls, [
    ['status', '--porcelain', '--', 'src/node/secrets.enc.json'],
    ['push']   // no commit call
  ]);
});

test('gitCommitPush surfaces a push failure as a thrown error', async () => {
  const run = async (args) => {
    if (args[0] === 'status') return ' M src/node/secrets.enc.json\n';
    if (args[0] === 'commit') return '';
    if (args[0] === 'push') throw new Error('! [rejected] main -> main (non-fast-forward)');
    return '';
  };
  await assert.rejects(() => gh.gitCommitPush(() => {}, { run }), /non-fast-forward/);
});
