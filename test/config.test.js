'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, DEFAULT_UUID, DEFAULT_WSPATH } = require('../src/node/config.js');

test('SERVER_PORT wins over PORT, which wins over the default', () => {
  assert.equal(loadConfig({ SERVER_PORT: '8080', PORT: '9090' }).port, 8080);
  assert.equal(loadConfig({ PORT: '9090' }).port, 9090);
  assert.equal(loadConfig({}).port, 3000);
});

test('SERVER_HOST wins over HOST, which wins over the default', () => {
  assert.equal(loadConfig({ SERVER_HOST: '127.0.0.1', HOST: '::' }).host, '127.0.0.1');
  assert.equal(loadConfig({ HOST: '::' }).host, '::');
  assert.equal(loadConfig({}).host, '0.0.0.0');
});

test('WSPATH and ADMIN_TOKEN fall back to their defaults', () => {
  assert.equal(loadConfig({}).wsPath, DEFAULT_WSPATH);
  assert.equal(loadConfig({ WSPATH: '/x' }).wsPath, '/x');
  assert.equal(loadConfig({}).adminToken, '', 'unset means the dashboard is hidden');
  assert.equal(loadConfig({ ADMIN_TOKEN: 't' }).adminToken, 't');
});

test('FRONT_SNI is read, trimmed and lowercased; unset means fronting off', () => {
  assert.equal(loadConfig({}).frontSni, '', 'unset disables fronting');
  assert.equal(loadConfig({ FRONT_SNI: '  ChatGPT.com ' }).frontSni, 'chatgpt.com');
});

test('the UUID is expanded to its 16 bytes', () => {
  const config = loadConfig({ UUID: '00112233-4455-6677-8899-aabbccddeeff' });
  assert.equal(config.uuidBytes.length, 16);
  assert.equal(config.uuidBytes[0], 0x00);
  assert.equal(config.uuidBytes[15], 0xff);
  assert.equal(config.uuid, '00112233-4455-6677-8899-aabbccddeeff');
});

test('a bare-hex UUID is accepted and a malformed one throws', () => {
  assert.equal(loadConfig({ UUID: '00112233445566778899aabbccddeeff' }).uuidBytes[15], 0xff);
  assert.throws(() => loadConfig({ UUID: 'not-a-uuid' }), /Invalid UUID/);
  // An empty value is treated as unset, so it falls back rather than throwing.
  assert.equal(loadConfig({ UUID: '' }).uuid, DEFAULT_UUID);
});

test('the default UUID is used when none is supplied', () => {
  assert.equal(loadConfig({}).uuid, DEFAULT_UUID);
});

test('the config is frozen so nothing can mutate it at runtime', () => {
  const config = loadConfig({});
  assert.ok(Object.isFrozen(config));
  assert.throws(() => { 'use strict'; config.port = 1; }, TypeError);
});

test('a header-size cap is present', () => {
  assert.ok(loadConfig({}).maxHeaderBytes > 0);
});

test('loadConfig reads process.env by default', () => {
  const saved = process.env.WSPATH;
  process.env.WSPATH = '/from-env';
  try {
    assert.equal(loadConfig().wsPath, '/from-env');
  } finally {
    if (saved === undefined) delete process.env.WSPATH;
    else process.env.WSPATH = saved;
  }
});
