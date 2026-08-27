'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { bannerText } = require('../src/node/server.js');
const { loadConfig } = require('../src/node/config.js');

test('banner prints the real dashboard URL when PUBLIC_HOST and ADMIN_TOKEN are set', () => {
  const banner = bannerText(loadConfig({ PUBLIC_HOST: 'example.com', ADMIN_TOKEN: 't' }));
  assert.match(banner, /Admin Stats: https:\/\/example\.com\/admin-stats\?token=t/);
  assert.match(banner, /Active on 0\.0\.0\.0:3000/, 'bind line stays — it maps to the compose ports entry');
});

test('banner appends PUBLIC_PORT only when it is not 443', () => {
  const at8443 = bannerText(loadConfig({ PUBLIC_HOST: 'example.com', PUBLIC_PORT: '8443', ADMIN_TOKEN: 't' }));
  assert.match(at8443, /https:\/\/example\.com:8443\/admin-stats/);
  const at443 = bannerText(loadConfig({ PUBLIC_HOST: 'example.com', PUBLIC_PORT: '443', ADMIN_TOKEN: 't' }));
  assert.match(at443, /https:\/\/example\.com\/admin-stats/);
});

test('banner falls back to the bind address without PUBLIC_HOST', () => {
  const banner = bannerText(loadConfig({ ADMIN_TOKEN: 't' }));
  assert.match(banner, /Admin Stats: http:\/\/0\.0\.0\.0:3000\/admin-stats\?token=t/);
});

test('banner never prints an admin URL without ADMIN_TOKEN — the route serves only the decoy', () => {
  const banner = bannerText(loadConfig({ PUBLIC_HOST: 'example.com' }));
  assert.doesNotMatch(banner, /admin-stats/);
  assert.match(banner, /Admin Stats: disabled \(set ADMIN_TOKEN\)/);
});

test('banner URL-encodes the token', () => {
  const banner = bannerText(loadConfig({ PUBLIC_HOST: 'example.com', ADMIN_TOKEN: 'a b&c' }));
  assert.match(banner, /\?token=a%20b%26c/);
});
