'use strict';

// What actually ships in the Docker image.
//
// The Dockerfile COPYs an explicit list — appws.js, src/vless.js, src/decoy.js
// and src/node/ — and there is no npm install. A module required from anywhere
// else, or a single runtime dependency, works perfectly in development and then
// crashes the container on boot with MODULE_NOT_FOUND, which Fly turns into a
// failed health check and a rolled-back deploy.
//
// That constraint otherwise lives only in a Dockerfile comment. This walks the
// real require graph and enforces it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'appws.js');

/**
 * Every require() literal in a file, ignoring comments.
 *
 * Comment stripping is not optional: server.js documents the importability
 * check as `node -e "require('./src/node/server.js')"` in a comment, and
 * treating that as a real edge sends the walk chasing a path that does not
 * exist.
 */
function requiresOf(file) {
  const src = fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const found = [];
  for (const m of src.matchAll(/require\(\s*'([^']+)'\s*\)/g)) found.push(m[1]);
  for (const m of src.matchAll(/require\(\s*"([^"]+)"\s*\)/g)) found.push(m[1]);
  return found;
}

/** Walk the graph from `entry`, returning every resolved file and every bare specifier. */
function walk(entry) {
  const files = new Set();
  const bare = new Set();
  const queue = [entry];

  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);

    for (const spec of requiresOf(file)) {
      if (!spec.startsWith('.')) {
        bare.add(spec);
        continue;
      }
      const resolved = require.resolve(path.resolve(path.dirname(file), spec));
      if (!files.has(resolved)) queue.push(resolved);
    }
  }

  return { files, bare };
}

test('every module the server loads is inside the image', () => {
  const { files } = walk(ENTRY);

  // Mirrors the Dockerfile's COPY list exactly.
  const shipped = [
    path.join(ROOT, 'appws.js'),
    path.join(ROOT, 'src', 'vless.js'),
    path.join(ROOT, 'src', 'decoy.js')
  ];
  const nodeDir = path.join(ROOT, 'src', 'node') + path.sep;

  for (const file of files) {
    const ok = shipped.includes(file) || file.startsWith(nodeDir);
    assert.ok(ok, `${path.relative(ROOT, file)} is required at runtime but is NOT copied ` +
                  'into the image — move it under src/node/ or add a COPY line');
  }

  assert.ok(files.size > 10, 'sanity: the walk should have found the whole server');
});

test('the server has no runtime npm dependencies', () => {
  const { bare } = walk(ENTRY);

  for (const spec of bare) {
    assert.ok(Module.isBuiltin(spec),
      `${spec} is not a Node built-in — the Dockerfile runs no npm install, so ` +
      'requiring it would crash the container on boot');
  }
});

test('package.json declares no dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined,
    'a runtime dependency needs a Dockerfile with npm install; see the comment there');
});

test('the Dockerfile still copies what the walk assumes', () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

  assert.match(dockerfile, /COPY appws\.js/);
  assert.match(dockerfile, /COPY src\/vless\.js src\/decoy\.js/);
  assert.match(dockerfile, /COPY src\/node\//);
  assert.ok(!/npm (install|ci)/.test(dockerfile),
    'adding an install step is a real decision — update these tests deliberately');
});

test('src/vless.js stays runtime-agnostic so the Worker keeps bundling', () => {
  // It is shared with src/worker/, which has no Node built-ins available.
  for (const spec of requiresOf(path.join(ROOT, 'src', 'vless.js'))) {
    assert.fail(`src/vless.js must require nothing, found: ${spec}`);
  }
  for (const spec of requiresOf(path.join(ROOT, 'src', 'decoy.js'))) {
    assert.fail(`src/decoy.js must require nothing, found: ${spec}`);
  }
});
