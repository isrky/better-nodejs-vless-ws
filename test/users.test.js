'use strict';

// The credential registry.
//
// The golden vectors below are the single most valuable assertion in the whole
// provisioning feature: UUIDs are derived, never stored, so an accidental edit
// to UUID_TAG, the truncation length or the version bits silently invalidates
// every already-provisioned device — with no error raised anywhere, on any
// machine. If these change, real people stop being able to connect.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createUserRegistry, deriveUser, parseUserLabels, isValidLabel, formatUuid,
  MAX_USERS, LEGACY_LABEL
} = require('../src/node/users.js');
const { uuidToBytes } = require('../src/vless.js');

const SECRET = 'test-provision-secret-0123456789';
const OWNER_UUID = '7bd180e8-1142-4387-93f5-03e8d750a896';

test('derived UUIDs match their recorded golden values', () => {
  // Regenerating these is only correct when the derivation change is DELIBERATE
  // and every provisioned device is being reissued.
  assert.equal(deriveUser(SECRET, 'alice').uuid, 'bb3d6381-f832-4549-b607-541f00917947');
  assert.equal(deriveUser(SECRET, 'bob').uuid, 'af71b88d-eb92-4720-9740-50232f7313c4');
  assert.equal(deriveUser(SECRET, 'carol').uuid, '8e30a51e-e631-4c6d-9219-f4031fecb029');
});

test('derivation is deterministic and separated by label and secret', () => {
  assert.equal(deriveUser(SECRET, 'alice').uuid, deriveUser(SECRET, 'alice').uuid);
  assert.notEqual(deriveUser(SECRET, 'alice').uuid, deriveUser(SECRET, 'alicf').uuid);
  assert.notEqual(deriveUser(SECRET, 'alice').uuid, deriveUser(SECRET + 'x', 'alice').uuid);
});

test('a derived UUID is a canonical v4 and round-trips through uuidToBytes', () => {
  const user = deriveUser(SECRET, 'alice');

  assert.match(user.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(user.bytes.length, 16);
  assert.equal(user.bytes[6] >> 4, 4, 'version nibble');
  assert.equal(user.bytes[8] >> 6, 0b10, 'RFC 4122 variant');
  assert.deepEqual(uuidToBytes(user.uuid), user.bytes, 'string and bytes cannot disagree');
});

test('formatUuid renders the canonical grouping', () => {
  const bytes = Uint8Array.from(Array.from({ length: 16 }, (_, i) => i));
  assert.equal(formatUuid(bytes), '00010203-0405-0607-0809-0a0b0c0d0e0f');
});

test('parseUserLabels accepts every reasonable separator and folds case', () => {
  const { labels } = parseUserLabels('alice, Bob;carol\ndave  eve');
  assert.deepEqual(labels, ['alice', 'bob', 'carol', 'dave', 'eve']);

  assert.deepEqual(parseUserLabels('alice,ALICE,Alice').labels, ['alice'],
    'case folding must not mint two credentials for one person');
  assert.deepEqual(parseUserLabels('').labels, []);
  assert.deepEqual(parseUserLabels(undefined).labels, []);
});

test('parseUserLabels rejects hostile and malformed labels without throwing', () => {
  // One at a time: several of these contain characters that are themselves
  // separators, so joining them would split into innocent fragments and test
  // nothing. (`USERS='a b'` legitimately means two users — see the separator
  // test above.)
  const hostile = [
    '<script>', 'a"b', "a'b", '../x', 'a/b', 'a\\b', 'a`b', 'a$b',
    '-leading', '_leading', 'héllo', 'a'.repeat(33), '.', '%2e%2e', 'a:b'
  ];

  for (const bad of hostile) {
    const { labels, rejected } = parseUserLabels(bad);
    assert.deepEqual(labels, [], `${JSON.stringify(bad)} must not become a user`);
    assert.deepEqual(rejected, [bad], `${JSON.stringify(bad)} must be reported`);
  }
});

test('a label can never contain the newline that separates the derivation tag', () => {
  // deriveUser concatenates UUID_TAG + label, which is only unambiguous because
  // a valid label cannot contain '\n'. This is the guard on that property.
  const { labels } = parseUserLabels('ali\nce');
  for (const label of labels) assert.ok(!label.includes('\n'));
  assert.deepEqual(labels, ['ali', 'ce'], 'a newline separates, it never survives inside a label');
});

test('the owner label is reserved so the invite flow cannot hand out the operator credential', () => {
  const { labels, rejected } = parseUserLabels(`alice,${LEGACY_LABEL},bob`);
  assert.deepEqual(labels, ['alice', 'bob']);
  assert.ok(rejected.includes(LEGACY_LABEL));
});

test('the user count is capped', () => {
  const many = Array.from({ length: MAX_USERS + 10 }, (_, i) => `u${i}`).join(',');
  const { labels, rejected } = parseUserLabels(many);
  assert.equal(labels.length, MAX_USERS);
  assert.equal(rejected.length, 10);
});

test('isValidLabel matches the documented charset', () => {
  for (const ok of ['a', 'a1', 'alice', 'a-b_c', 'a'.repeat(32)]) {
    assert.equal(isValidLabel(ok), true, ok);
  }
  for (const bad of ['', '-a', '_a', 'a b', 'a.b', 'a'.repeat(33), 'ALICE', null, 42]) {
    assert.equal(isValidLabel(bad), false, String(bad));
  }
});

// ---------- registry ----------

function registry(over = {}) {
  return createUserRegistry({
    secrets: [SECRET], labels: ['alice', 'bob'], legacyUuid: OWNER_UUID, ...over
  });
}

test('lookup finds a provisioned user and reports the label', () => {
  const reg = registry();
  const alice = reg.mintable('alice');

  const payload = new Uint8Array(18);
  payload.set(alice.bytes, 1);
  assert.equal(reg.lookup(payload, 1).label, 'alice');
});

test('lookup checks all sixteen bytes, not just the bucket key', () => {
  // The first four bytes select the bucket; a miss in only the LAST byte is the
  // case that a bucket-key-only comparison would wrongly accept.
  const reg = registry();
  const payload = new Uint8Array(18);
  payload.set(reg.mintable('alice').bytes, 1);

  payload[16] ^= 0xff;
  assert.equal(reg.lookup(payload, 1), null);
});

test('an unknown credential does not match', () => {
  const reg = registry();
  const payload = new Uint8Array(18);
  payload.set(uuidToBytes('00000000-0000-4000-8000-000000000000'), 1);
  assert.equal(reg.lookup(payload, 1), null);
});

test('the operator UUID authenticates as owner and is never listed', () => {
  const reg = registry();
  const payload = new Uint8Array(18);
  payload.set(uuidToBytes(OWNER_UUID), 1);

  assert.equal(reg.lookup(payload, 1).label, LEGACY_LABEL);
  assert.deepEqual(reg.list().map((u) => u.label), ['alice', 'bob'],
    'owner must not be mintable through the UI');
  assert.equal(reg.mintable(LEGACY_LABEL), null, 'the owner is never mintable');
});

test('list() exposes labels only, never credentials', () => {
  const serialised = JSON.stringify(registry().list());
  assert.equal(serialised, '[{"label":"alice"},{"label":"bob"}]');
  assert.ok(!serialised.includes('-'), 'no UUID may appear');
});

test('with no secret there is no provisioning and USERS is ignored', () => {
  const reg = createUserRegistry({ secrets: [], labels: ['alice'], legacyUuid: OWNER_UUID });

  assert.equal(reg.provisioning, false);
  assert.equal(reg.mintable('alice'), null, 'no credential can be derived without a secret');

  const payload = new Uint8Array(18);
  payload.set(uuidToBytes(OWNER_UUID), 1);
  assert.equal(reg.lookup(payload, 1).label, LEGACY_LABEL, 'the owner still works');
});

test('a previous secret keeps old devices working while new invites use the current one', () => {
  const OLD = 'previous-provision-secret-000000';
  const reg = createUserRegistry({
    secrets: [SECRET, OLD], labels: ['alice'], legacyUuid: OWNER_UUID
  });

  const current = deriveUser(SECRET, 'alice');
  const previous = deriveUser(OLD, 'alice');
  assert.notEqual(current.uuid, previous.uuid);

  for (const user of [current, previous]) {
    const payload = new Uint8Array(18);
    payload.set(user.bytes, 1);
    assert.equal(reg.lookup(payload, 1).label, 'alice', `${user.uuid} must authenticate`);
  }

  assert.equal(reg.mintable('alice').uuid, current.uuid, 'new invites mint the current credential');
});

test('every user in a many-user registry is reachable', () => {
  // Exercises the bucket path at scale: with MAX_USERS entries all sharing one
  // Map, a user must never be shadowed by another's bucket.
  const labels = Array.from({ length: MAX_USERS }, (_, i) => `u${i}`);
  const reg = createUserRegistry({ secrets: [SECRET], labels, legacyUuid: OWNER_UUID });

  for (const label of labels) {
    const payload = new Uint8Array(18);
    payload.set(reg.mintable(label).bytes, 1);
    assert.equal(reg.lookup(payload, 1).label, label);
  }
  assert.equal(reg.size, MAX_USERS + 1, 'plus the owner');
});

test('an empty registry authenticates nobody', () => {
  const reg = createUserRegistry({ secrets: [], labels: [], legacyUuid: null });
  assert.equal(reg.size, 0);
  assert.equal(reg.lookup(new Uint8Array(18), 1), null);
});
