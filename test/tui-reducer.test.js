'use strict';

// The Ink dashboard's state machine.
//
// The reducer is pure — writes and probes leave as effect descriptors, and
// generated values arrive in action payloads — so every flow the old scripted
// menu tests drove is asserted here without rendering a frame. Where the old
// suite checked "written through immediately", the write-store effect is
// executed against a real tmp store so the on-disk claim survives. What this
// cannot cover (real keystrokes, terminal restore) stays with the subprocess
// tests in credentials.test.js and the manual checklist in CREDENTIALS.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let td;
let cs;

test.before(async () => {
  td = await import('../tools/tui/reducer.mjs');
  cs = await import('../tools/credstore.mjs');
});

// Repo lookups stubbed: no fly.toml reads, fixed platform names.
const deps = { warnings: () => [], names: () => ({ fly: 'my-app', worker: 'my-worker' }) };

function tmpStore(extra = {}) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tui-')), 'credentials.json');
  const store = cs.emptyStore();
  Object.assign(store.credentials, {
    UUID: '00000000-0000-4000-8000-000000000001',
    WSPATH: '/test-ws-path',
    FLY_HOST: 'fly.example.dev',
    WORKER_HOST: 'worker.example.dev'
  }, extra);
  cs.writeStore(p, store);
  return { storePath: p, store };
}

function init(ctx) {
  return td.initState({ store: ctx.store, storePath: ctx.storePath }, deps);
}

/**
 * Dispatch one action; execute any write-store effect against the real store
 * file (the write-through contract), collect every effect for assertions.
 */
function step(state, action, { ctx = null, effects = [] } = {}) {
  const r = td.reduce(state, action, deps);
  for (const eff of r.effects || []) {
    effects.push(eff);
    if (eff.type === 'write-store' && ctx) cs.writeStore(ctx.storePath, eff.store);
  }
  return r.state;
}

function typeText(state, text, opts) {
  for (const ch of text) state = step(state, { type: 'INPUT_CHAR', text: ch }, opts);
  return state;
}

const at = (state, key) => ({
  ...state,
  cursor: cs.FIELDS.findIndex((f) => f.key === key),
  tab: td.tabOfKey(key)
});
const lastMessage = (state) => state.messages[state.messages.length - 1]?.text || '';
const visibleJson = (state) => JSON.stringify(td.visibleState(state));

// ---------- the dashboard ----------

test('q maps to QUIT and exits with code 0', () => {
  const state = init(tmpStore());
  assert.deepEqual(td.keymap(state, 'q', {}), { type: 'QUIT' });

  const effects = [];
  const next = step(state, { type: 'QUIT' }, { effects });
  assert.deepEqual(next.exit, { code: 0, post: null });
  assert.deepEqual(effects, [{ type: 'exit', code: 0 }]);
});

test('ctrl-c maps to INTERRUPT and exits with code 130 in every mode', () => {
  let state = init(tmpStore());
  for (const mode of ['dashboard', 'edit', 'ca-select', 'reveal-confirm']) {
    assert.deepEqual(td.keymap({ ...state, mode }, 'c', { ctrl: true }), { type: 'INTERRUPT' });
  }
  const effects = [];
  const next = step(state, { type: 'INTERRUPT' }, { effects });
  assert.equal(next.exit.code, 130);
  assert.deepEqual(effects, [{ type: 'exit', code: 130 }]);
});

test('an unhandled key is null, not fatal', () => {
  const state = init(tmpStore());
  assert.equal(td.keymap(state, 'z', {}), null);
});

test('the cursor wraps around both ends of the active tab', () => {
  const state = init(tmpStore());
  const uuid = cs.FIELDS.findIndex((f) => f.key === 'UUID');
  const wspath = cs.FIELDS.findIndex((f) => f.key === 'WSPATH');

  // The common tab holds UUID and WSPATH only: k on UUID wraps to WSPATH and
  // j on WSPATH back to UUID — never into another group's fields.
  assert.equal(step(state, { type: 'MOVE', delta: -1 }).cursor, wspath);
  assert.equal(step({ ...state, cursor: wspath }, { type: 'MOVE', delta: 1 }).cursor, uuid);
});

// ---------- the group tabs ----------

test('the tabs are one per group plus config, envs and nuke, and data tabs partition every field', () => {
  const state = init(tmpStore());
  assert.deepEqual(td.visibleState(state).tabs.map((t) => t.name),
    [...Object.keys(cs.GROUPS), 'config', 'envs', 'nuke']);

  // Each tab lists exactly its own fields; across all tabs every field
  // appears exactly once. The action tabs (envs, nuke) hold no fields.
  const seen = [];
  for (const tab of td.TABS.filter((name) => name !== 'nuke' && name !== 'envs')) {
    const rows = td.visibleState({ ...state, tab }).activeGroup.rows;
    for (const f of cs.FIELDS) {
      const expected = td.tabOfKey(f.key) === tab;
      assert.equal(rows.some((r) => r.key === f.key), expected,
        `${f.key} is ${expected ? 'missing from' : 'does not belong on'} the ${tab} tab`);
    }
    seen.push(...rows.map((r) => r.key));
  }
  assert.deepEqual(seen.sort(), cs.FIELDS.map((f) => f.key).sort());
  assert.equal(td.visibleState({ ...state, tab: 'nuke' }).activeGroup, null,
    'the action tab has no credential rows');
  assert.equal(td.visibleState({ ...state, tab: 'envs' }).activeGroup, null,
    'the envs tab has no credential rows');

  // The tab bar counts each tab's problems, so a broken field is visible
  // from every tab — here the empty store misses all four required fields,
  // three of which are render/config, one is common.
  const empty = init({ storePath: '/tmp/none.json', store: cs.emptyStore() });
  const counts = Object.fromEntries(td.visibleState(empty).tabs.map((t) => [t.name, t.problems]));
  assert.equal(counts.common, 2, 'UUID and WSPATH are required');
  assert.equal(counts.config, 2, 'FLY_HOST and WORKER_HOST are required');
  assert.equal(counts.server, 0);
});

test('tab, shift-tab, arrows and h/l switch tabs; they stay text in the editor', () => {
  const state = init(tmpStore());
  assert.deepEqual(td.keymap(state, '', { tab: true }), { type: 'TAB_MOVE', delta: 1 });
  assert.deepEqual(td.keymap(state, '', { tab: true, shift: true }), { type: 'TAB_MOVE', delta: -1 });
  assert.deepEqual(td.keymap(state, 'h', {}), { type: 'TAB_MOVE', delta: -1 });
  assert.deepEqual(td.keymap(state, 'l', {}), { type: 'TAB_MOVE', delta: 1 });
  assert.deepEqual(td.keymap(state, '', { leftArrow: true }), { type: 'TAB_MOVE', delta: -1 });
  assert.deepEqual(td.keymap(state, '', { rightArrow: true }), { type: 'TAB_MOVE', delta: 1 });

  // Inside the editor h/l are literal characters and tab is still ignored.
  const editing = step(at(state, 'FLY_HOST'), { type: 'OPEN_EDIT' });
  assert.deepEqual(td.keymap(editing, 'h', {}), { type: 'INPUT_CHAR', text: 'h' });
  assert.equal(td.keymap(editing, '', { tab: true }), null);
});

test('switching tabs lands on the tab\'s fields and remembers where you were', () => {
  let state = init(tmpStore());
  assert.equal(state.tab, 'common');
  assert.equal(cs.FIELDS[state.cursor].key, 'UUID');

  state = step(state, { type: 'MOVE', delta: 1 });         // onto WSPATH
  state = step(state, { type: 'TAB_MOVE', delta: 1 });     // server
  assert.equal(state.tab, 'server');
  assert.equal(cs.FIELDS[state.cursor].key, 'ADMIN_TOKEN');

  state = step(state, { type: 'MOVE', delta: 1 });         // PROVISION_SECRET
  state = step(state, { type: 'TAB_MOVE', delta: 1 });     // edge
  assert.equal(cs.FIELDS[state.cursor].key, 'PROXYIP');

  state = step(state, { type: 'TAB_MOVE', delta: -1 });    // back to server
  assert.equal(cs.FIELDS[state.cursor].key, 'PROVISION_SECRET', 'server restores its cursor');

  state = step(state, { type: 'TAB_MOVE', delta: -1 });    // back to common
  assert.equal(cs.FIELDS[state.cursor].key, 'WSPATH', 'common restores its cursor');

  // The tabs wrap: left of common is nuke, then envs, then config.
  state = step(state, { type: 'TAB_MOVE', delta: -1 });
  assert.equal(state.tab, 'nuke');
  state = step(state, { type: 'TAB_MOVE', delta: -1 });
  assert.equal(state.tab, 'envs');
  state = step(state, { type: 'TAB_MOVE', delta: -1 });
  assert.equal(state.tab, 'config');
  assert.equal(cs.FIELDS[state.cursor].key, 'FLY_HOST');
});

test('opening a field switches to its tab, so the setup walk follows along', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tui-')), 'credentials.json');
  const store = cs.emptyStore();
  cs.writeStore(p, store);
  const ctx = { storePath: p, store };

  let state = init(ctx);
  state = step(state, td.enrich(state, { type: 'SETUP_START' }, cs.generate), { ctx });
  state = step(state, { type: 'SETUP_SECRETS', yes: false }, { ctx });

  assert.equal(state.edit.key, 'FLY_HOST');
  assert.equal(state.tab, 'config', 'the walk visibly follows the field across tabs');

  // A direct OPEN_EDIT lands on the field's tab too.
  const opened = step(at(state, 'PROXYIP'), { type: 'OPEN_EDIT' });
  assert.equal(opened.tab, 'edge');
});

test('the help bar only advertises what the highlighted field supports', () => {
  const ctx = tmpStore({ DENO_HOST: 'deno.example.dev' });
  const state = init(ctx);
  const bar = (key) => td.visibleState(at(state, key)).helpBar;

  // FRONT_SNI: no generator, optional but unset in tmpStore -> neither hint.
  const sni = bar('FRONT_SNI');
  assert.ok(!/g generate/.test(sni), 'FRONT_SNI cannot be generated');
  assert.ok(!/c clear/.test(sni), 'an unset field has nothing to clear');
  assert.match(sni, /enter edit/);
  assert.match(sni, /←→\/hl tabs/, 'the tab hint is always advertised');

  // UUID: generatable but required -> g, no c.
  const uuid = bar('UUID');
  assert.match(uuid, /g generate/);
  assert.ok(!/c clear/.test(uuid), 'a required field cannot be cleared');

  // DENO_HOST: optional and set -> c, but no generator so no g.
  const deno = bar('DENO_HOST');
  assert.match(deno, /c clear/, 'a set optional field can be cleared');
  assert.ok(!/g generate/.test(deno), 'a host has no generator');

  // The CA field opens the tri-state select, not a text editor.
  const ca = bar('INTERCEPT_CA_FILE');
  assert.match(ca, /enter choose CA/);
  assert.ok(!/g generate/.test(ca));
});

test('g on the highlighted field generates and writes through immediately', () => {
  // Write-through, not save-on-exit: a freshly generated UUID that existed
  // only in memory would be exactly the thing you cannot recover.
  const ctx = tmpStore();
  const before = cs.readStore(ctx.storePath).credentials.UUID;

  let state = at(init(ctx), 'UUID');
  const action = td.enrich(state, td.keymap(state, 'g', {}));
  state = step(state, action, { ctx });

  const after = cs.readStore(ctx.storePath).credentials.UUID;
  assert.notEqual(after, before);
  assert.equal(cs.validateField('UUID', after), null);
  assert.ok(!visibleJson(state).includes(after.slice(9)), 'only the first 8 characters may be shown');
});

test('bare enter keeps the current value', () => {
  const ctx = tmpStore();
  let state = at(init(ctx), 'UUID');
  const effects = [];
  state = step(state, { type: 'OPEN_EDIT' }, { effects });
  state = step(state, { type: 'SUBMIT' }, { ctx, effects });

  assert.equal(state.mode, 'dashboard');
  assert.equal(effects.length, 0, 'a kept value must not be rewritten');
  assert.equal(cs.readStore(ctx.storePath).credentials.UUID, ctx.store.credentials.UUID);
});

test('an invalid value keeps the editor open instead of aborting', () => {
  const ctx = tmpStore();
  let state = at(init(ctx), 'FLY_HOST');
  state = step(state, { type: 'OPEN_EDIT' });
  state = typeText(state, 'nope.example:443');
  state = step(state, { type: 'SUBMIT' }, { ctx });

  assert.equal(state.mode, 'edit', 'the session must survive a bad entry');
  assert.match(state.edit.error, /not a valid hostname/);

  state = step(state, { type: 'CLEAR_BUFFER' });
  state = typeText(state, 'good.example.dev');
  state = step(state, { type: 'SUBMIT' }, { ctx });
  assert.equal(cs.readStore(ctx.storePath).credentials.FLY_HOST, 'good.example.dev');
});

test('a rejected secret value never reaches anything the components render', () => {
  const ctx = tmpStore();
  let state = at(init(ctx), 'UUID');
  state = step(state, { type: 'OPEN_EDIT' });
  state = typeText(state, 'SENTINEL-BAD-UUID-VALUE');
  state = step(state, { type: 'SUBMIT' }, { ctx });

  assert.match(state.edit.error, /UUID/);
  assert.ok(!visibleJson(state).includes('SENTINEL-BAD-UUID-VALUE'),
    'the rejected input may be a credential');
});

test('up arrow loads the current value into the editor to edit in place', () => {
  const ctx = tmpStore();
  let state = at(init(ctx), 'FLY_HOST');
  state = step(state, { type: 'OPEN_EDIT' });
  assert.equal(state.edit.buffer, '', 'the editor opens empty');
  assert.deepEqual(td.keymap(state, '', { upArrow: true }), { type: 'LOAD_CURRENT' });

  state = step(state, { type: 'LOAD_CURRENT' });
  assert.equal(state.edit.buffer, 'fly.example.dev', 'the stored value is pulled in');
  assert.equal(state.edit.caret, state.edit.buffer.length, 'the caret follows the loaded value');

  // fix a typo and submit, without retyping the whole host
  state = step(state, { type: 'BACKSPACE' });
  state = typeText(state, 'v');
  state = step(state, { type: 'SUBMIT' }, { ctx });
  assert.equal(cs.readStore(ctx.storePath).credentials.FLY_HOST, 'fly.example.dev'.slice(0, -1) + 'v');
});

test('the editor inserts and deletes at a movable caret', () => {
  let state = at(init(tmpStore()), 'FLY_HOST');
  state = step(state, { type: 'OPEN_EDIT' });
  state = typeText(state, 'ac');
  state = step(state, { type: 'MOVE_CARET', delta: -1 });
  state = typeText(state, 'b');
  assert.equal(state.edit.buffer, 'abc');
  assert.equal(state.edit.caret, 2);

  state = step(state, { type: 'MOVE_CARET', to: 'home' });
  state = step(state, { type: 'DELETE_FORWARD' });
  assert.equal(state.edit.buffer, 'bc');
  state = step(state, { type: 'MOVE_CARET', to: 'end' });
  state = step(state, { type: 'BACKSPACE' });
  assert.deepEqual({ buffer: state.edit.buffer, caret: state.edit.caret }, { buffer: 'b', caret: 1 });

  assert.deepEqual(td.keymap(state, '', { leftArrow: true }), { type: 'MOVE_CARET', delta: -1 });
  assert.deepEqual(td.keymap(state, '', { rightArrow: true }), { type: 'MOVE_CARET', delta: 1 });
  assert.deepEqual(td.keymap(state, '', { home: true }), { type: 'MOVE_CARET', to: 'home' });
  assert.deepEqual(td.keymap(state, '', { end: true }), { type: 'MOVE_CARET', to: 'end' });
  assert.deepEqual(td.keymap(state, '', { delete: true }), { type: 'DELETE_FORWARD' });
});

test('up arrow on an unset field is a no-op, and j stays a literal character', () => {
  const ctx = tmpStore();
  let state = at(init(ctx), 'DENO_HOST');   // unset in tmpStore
  state = step(state, { type: 'OPEN_EDIT' });
  state = step(state, { type: 'LOAD_CURRENT' });
  assert.equal(state.edit.buffer, '', 'nothing to load from an unset field');

  // j must remain typable text inside the editor, not a navigation key
  assert.deepEqual(td.keymap(state, 'j', {}), { type: 'INPUT_CHAR', text: 'j' });
});

test('a secret editor buffer renders as a mask, a hostname buffer verbatim', () => {
  const ctx = tmpStore();

  let secret = at(init(ctx), 'ADMIN_TOKEN');
  secret = step(secret, { type: 'OPEN_EDIT' });
  secret = typeText(secret, 'hunter2token');
  const sv = td.visibleState(secret);
  assert.ok(!sv.editor.display.includes('hunter2token'), 'the typed secret is masked');
  assert.match(sv.editor.display, /\(12 chars\)$/, 'the mask still shows the length');

  let host = at(init(ctx), 'FLY_HOST');
  host = step(host, { type: 'OPEN_EDIT' });
  host = typeText(host, 'new.example.dev');
  assert.equal(td.visibleState(host).editor.display, 'new.example.dev',
    'a hostname stays correctable on screen');
});

test('a required field refuses to be cleared, an optional one clears through', () => {
  const ctx = tmpStore({ ADMIN_TOKEN: 'a'.repeat(44) });
  let state = at(init(ctx), 'UUID');
  const effects = [];
  state = step(state, { type: 'CLEAR_FIELD' }, { ctx, effects });
  assert.match(lastMessage(state), /UUID is required/);
  assert.equal(effects.length, 0);
  assert.ok(cs.readStore(ctx.storePath).credentials.UUID, 'and it is still set');

  state = at(state, 'ADMIN_TOKEN');
  state = step(state, { type: 'CLEAR_FIELD' }, { ctx, effects });
  assert.equal(effects.length, 1);
  assert.equal('ADMIN_TOKEN' in cs.readStore(ctx.storePath).credentials, false);
});

// ---------- user manager ----------

test('USERS opens a list manager and add writes a normalized label immediately', () => {
  const ctx = tmpStore({ PROVISION_SECRET: 'provision-secret' });
  let state = at(init(ctx), 'USERS');
  state = step(state, { type: 'OPEN_EDIT' });
  assert.equal(state.mode, 'users');
  assert.equal(td.visibleState(state).userManager.count, 0);
  assert.deepEqual(td.keymap(state, 'a', {}), { type: 'USERS_ADD' });

  state = step(state, { type: 'USERS_ADD' });
  for (const ch of ' Alice ') state = step(state, { type: 'USERS_INPUT', text: ch });
  const effects = [];
  state = step(state, { type: 'USERS_SUBMIT' }, { ctx, effects });

  assert.equal(state.users.view, 'list');
  assert.equal(cs.readStore(ctx.storePath).credentials.USERS, 'alice');
  assert.equal(effects[0].type, 'write-store');
  assert.match(lastMessage(state), /commit and redeploy/);
});

test('user add rejects reserved, duplicate and malformed labels', () => {
  const ctx = tmpStore({ USERS: 'alice' });
  let state = step(at(init(ctx), 'USERS'), { type: 'OPEN_EDIT' });

  for (const bad of ['owner', 'alice', 'not valid']) {
    state = step(state, { type: 'USERS_ADD' });
    for (const ch of bad) state = step(state, { type: 'USERS_INPUT', text: ch });
    state = step(state, { type: 'USERS_SUBMIT' });
    assert.equal(state.users.view, 'input');
    assert.ok(state.users.draft.error, bad);
    state = step(state, { type: 'USERS_CANCEL' });
  }
  assert.equal(ctx.store.credentials.USERS, 'alice');
});

test('the user manager refuses additions at the runtime registry limit', () => {
  const labels = Array.from({ length: cs.maxUserLabels() }, (_, index) => `u${index}`);
  const ctx = tmpStore({ USERS: labels.join(' ') });
  let state = step(at(init(ctx), 'USERS'), { type: 'OPEN_EDIT' });
  state = step(state, { type: 'USERS_ADD' });
  assert.equal(state.users.view, 'list');
  assert.match(state.users.error, /maximum 64/);
});

test('rename confirms before replacing the label in place', () => {
  const ctx = tmpStore({ USERS: 'alice bob' });
  let state = step(at(init(ctx), 'USERS'), { type: 'OPEN_EDIT' });
  state = step(state, { type: 'USERS_MOVE', delta: 1 });
  state = step(state, { type: 'USERS_RENAME' });
  assert.deepEqual({ buffer: state.users.draft.buffer, caret: state.users.draft.caret }, { buffer: 'bob', caret: 3 });
  state = step(state, { type: 'USERS_CLEAR_INPUT' });
  for (const ch of 'carol') state = step(state, { type: 'USERS_INPUT', text: ch });
  state = step(state, { type: 'USERS_SUBMIT' });
  assert.equal(state.users.view, 'confirm');
  assert.equal(cs.readStore(ctx.storePath).credentials.USERS, 'alice bob', 'submit only opens confirmation');

  const effects = [];
  state = step(state, { type: 'USERS_CONFIRM', yes: true }, { ctx, effects });
  assert.equal(cs.readStore(ctx.storePath).credentials.USERS, 'alice carol');
  assert.equal(state.users.cursor, 1);
  assert.match(lastMessage(state), /revoke the old identity/);
  assert.equal(effects.length, 1);
});

test('delete and delete-all confirm, with the last deletion unsetting USERS', () => {
  const ctx = tmpStore({ USERS: 'alice bob' });
  let state = step(at(init(ctx), 'USERS'), { type: 'OPEN_EDIT' });
  state = step(state, { type: 'USERS_DELETE' });
  state = step(state, { type: 'USERS_CONFIRM', yes: false });
  assert.equal(cs.readStore(ctx.storePath).credentials.USERS, 'alice bob');

  state = step(state, { type: 'USERS_DELETE' });
  state = step(state, { type: 'USERS_CONFIRM', yes: true }, { ctx });
  assert.equal(cs.readStore(ctx.storePath).credentials.USERS, 'bob');

  state = step(state, { type: 'USERS_CLEAR_ALL' });
  state = step(state, { type: 'USERS_CONFIRM', yes: true }, { ctx });
  assert.equal('USERS' in cs.readStore(ctx.storePath).credentials, false);
  assert.equal(td.visibleState(state).userManager.count, 0);
});

test('dashboard c on USERS requires a delete-all confirmation', () => {
  const ctx = tmpStore({ USERS: 'alice bob' });
  let state = at(init(ctx), 'USERS');
  state = step(state, { type: 'CLEAR_FIELD' }, { ctx });
  assert.equal(state.mode, 'users');
  assert.equal(state.users.confirm.kind, 'clear');
  assert.equal(cs.readStore(ctx.storePath).credentials.USERS, 'alice bob');
});

test('PROVISION_SECRET_PREVIOUS cannot be generated', () => {
  const ctx = tmpStore();
  let state = at(init(ctx), 'PROVISION_SECRET_PREVIOUS');
  const action = td.enrich(state, td.keymap(state, 'g', {}), () => 'should-not-be-used');
  assert.equal(action.value, null, 'enrich must not invent a value for it');

  const effects = [];
  state = step(state, action, { ctx, effects });
  assert.match(lastMessage(state), /cannot be generated/);
  assert.equal(effects.length, 0);
});

test('undo emits restore-backup, and UNDO_OK swaps the store in', () => {
  const ctx = tmpStore();
  const original = ctx.store.credentials.UUID;

  let state = at(init(ctx), 'UUID');
  state = step(state, td.enrich(state, { type: 'GENERATE' }), { ctx });
  assert.notEqual(cs.readStore(ctx.storePath).credentials.UUID, original);

  const effects = [];
  state = step(state, { type: 'UNDO' }, { effects });
  assert.deepEqual(effects, [{ type: 'restore-backup' }]);

  const restored = cs.restoreBackup(ctx.storePath);
  state = step(state, { type: 'UNDO_OK', store: restored });
  assert.equal(state.store.credentials.UUID, original);
  assert.equal(cs.readStore(ctx.storePath).credentials.UUID, original);
  assert.match(lastMessage(state), /restored/);
});

test('a failed write rolls the optimistic store back', () => {
  const ctx = tmpStore();
  let state = at(init(ctx), 'FLY_HOST');
  state = step(state, { type: 'OPEN_EDIT' });
  state = typeText(state, 'new.example.dev');

  const effects = [];
  state = step(state, { type: 'SUBMIT' }, { effects });
  assert.equal(state.store.credentials.FLY_HOST, 'new.example.dev', 'applied optimistically');

  state = step(state, { type: 'WRITE_FAILED', message: 'disk full', rollback: effects[0].rollback });
  assert.equal(state.store.credentials.FLY_HOST, 'fly.example.dev', 'reverted exactly');
  assert.match(lastMessage(state), /disk full/);
});

// ---------- the CA tri-state ----------

test('the CA select sets all three states without ever typing an empty string', () => {
  const ctx = tmpStore();
  let state = at(init(ctx), 'INTERCEPT_CA_FILE');

  state = step(state, { type: 'OPEN_EDIT' });
  assert.equal(state.mode, 'ca-select');

  // none -> the explicit empty string
  state = step(state, { type: 'CA_PICK', index: 1 }, { ctx });
  assert.equal(cs.readStore(ctx.storePath).credentials.INTERCEPT_CA_FILE, '');

  // bundled -> the key is deleted, which is a different state from ''
  state = step(state, { type: 'OPEN_EDIT' });
  state = step(state, { type: 'CA_PICK', index: 0 }, { ctx });
  assert.equal('INTERCEPT_CA_FILE' in cs.readStore(ctx.storePath).credentials, false);

  // file -> chains into the path editor
  state = step(state, { type: 'OPEN_EDIT' });
  state = step(state, { type: 'CA_PICK', index: 2 });
  assert.equal(state.mode, 'ca-path');
  state = typeText(state, 'test/fixtures/ca.pem');
  state = step(state, { type: 'SUBMIT' }, { ctx });
  assert.equal(cs.readStore(ctx.storePath).credentials.INTERCEPT_CA_FILE, 'test/fixtures/ca.pem');
});

test('the CA path editor rejects a DER path and stays open', () => {
  const ctx = tmpStore();
  let state = at(init(ctx), 'INTERCEPT_CA_FILE');
  state = step(state, { type: 'OPEN_EDIT' });
  state = step(state, { type: 'CA_PICK', index: 2 });
  state = typeText(state, 'MEB_SERTIFIKASI.cer');
  state = step(state, { type: 'SUBMIT' }, { ctx });

  assert.equal(state.mode, 'ca-path');
  assert.match(state.edit.error, /DER/);
  assert.equal('INTERCEPT_CA_FILE' in cs.readStore(ctx.storePath).credentials, false);
});

test('the CA select opens on the current state', () => {
  const ctx = tmpStore({ INTERCEPT_CA_FILE: '' });
  let state = at(init(ctx), 'INTERCEPT_CA_FILE');
  state = step(state, { type: 'OPEN_EDIT' });
  assert.equal(state.caCursor, 1, '"" is the none state');
  assert.equal(td.visibleState(state).caSelect.options[1].current, true);
});

// ---------- emergency rotation ----------

test('the nuke tab is danger-styled and offers soft and full actions', () => {
  const state = { ...init(tmpStore()), tab: 'nuke' };
  const vs = td.visibleState(state);
  const tab = vs.tabs.find((item) => item.name === 'nuke');
  assert.equal(tab.danger, true);
  assert.equal(tab.active, true);
  assert.deepEqual(vs.nuke.choices.map((choice) => choice.name), ['soft', 'full']);
  assert.equal(vs.nuke.choices[1].disabled, true, 'tmp/custom stores cannot rotate canonical keys');

  assert.deepEqual(td.keymap(state, '', { return: true }), { type: 'NUKE_OPEN' });
  const opened = step(state, { type: 'NUKE_OPEN' });
  assert.equal(opened.mode, 'nuke-confirm');
  assert.equal(opened.nuke.kind, 'soft');
});

test('nuke confirmation is case-insensitive and supports editing/cancel', () => {
  let state = { ...init(tmpStore()), tab: 'nuke' };
  state = step(state, { type: 'NUKE_OPEN' });

  // A word that is not "nuke" in any case still errors.
  for (const ch of 'xy') state = step(state, td.keymap(state, ch, {}));
  state = step(state, td.enrich(state, td.keymap(state, '', { return: true }), () => 'unused'));
  assert.equal(state.mode, 'nuke-confirm');
  assert.match(state.nuke.error, /type NUKE/);

  // Editing and cancel keys are wired.
  assert.deepEqual(td.keymap(state, '', { backspace: true }), { type: 'NUKE_BACKSPACE' });
  assert.deepEqual(td.keymap(state, '', { escape: true }), { type: 'NUKE_CANCEL' });
  state = step(state, { type: 'NUKE_CANCEL' });
  assert.equal(state.mode, 'dashboard');
  assert.equal(state.nuke, null);

  // Reopen: a lowercase confirmation is accepted just like the uppercase word.
  state = step(state, { type: 'NUKE_OPEN' });
  for (const ch of 'nuke') state = step(state, td.keymap(state, ch, {}));
  const action = td.enrich(state, td.keymap(state, '', { return: true }), (key) => `new-${key}`);
  state = step(state, action);
  assert.equal(state.mode, 'nuke-running');
});

test('soft nuke rotates active credentials and rolls provisioning current into previous', () => {
  const ctx = tmpStore({
    ADMIN_TOKEN: 'old-admin',
    PROVISION_SECRET: 'old-provision',
    PROVISION_SECRET_PREVIOUS: 'older-provision',
    USERS: 'alice bob',
    PROXYIP: 'proxy.example.dev'
  });
  let state = { ...init(ctx), tab: 'nuke' };
  state = step(state, { type: 'NUKE_OPEN' });
  state = { ...state, nuke: { ...state.nuke, input: 'NUKE' } };
  const action = td.enrich(state, { type: 'NUKE_SUBMIT' }, (key) => `new-${key}`);
  const effects = [];
  state = step(state, action, { effects });

  assert.equal(state.mode, 'nuke-running');
  assert.equal(state.store.credentials.UUID, 'new-UUID');
  assert.equal(state.store.credentials.WSPATH, 'new-WSPATH');
  assert.equal(state.store.credentials.ADMIN_TOKEN, 'new-ADMIN_TOKEN');
  assert.equal(state.store.credentials.PROVISION_SECRET, 'new-PROVISION_SECRET');
  assert.equal(state.store.credentials.PROVISION_SECRET_PREVIOUS, 'old-provision');
  assert.equal(state.store.credentials.USERS, 'alice bob');
  assert.equal(state.store.credentials.PROXYIP, 'proxy.example.dev');
  assert.equal(effects[0].type, 'nuke');
  assert.equal(effects[0].kind, 'soft');

  state = step(state, { type: 'NUKE_OK', keyringGroups: ['common'], encrypted: true });
  assert.equal(state.mode, 'nuke-done');
  assert.equal(td.visibleState(state).nuke.done.kind, 'soft');
  assert.ok(!visibleJson(state).includes('new-ADMIN_TOKEN'));
});

test('full nuke rotates credentials and clears the previous provisioning secret', () => {
  const ctx = tmpStore({
    ADMIN_TOKEN: 'old-admin',
    PROVISION_SECRET: 'old-provision',
    PROVISION_SECRET_PREVIOUS: 'older-provision'
  });
  let state = td.initState({
    ...ctx, tab: 'nuke', canFullNuke: true,
    keyringGroups: Object.keys(cs.GROUPS)
  }, deps);
  state = { ...state, tab: 'nuke', nukeCursor: 1 };
  state = step(state, { type: 'NUKE_OPEN' });
  assert.equal(state.nuke.kind, 'full');

  state = { ...state, nuke: { ...state.nuke, input: 'NUKE' } };
  const action = td.enrich(state, { type: 'NUKE_SUBMIT' }, (key) => `new-${key}`);
  const effects = [];
  state = step(state, action, { effects });

  assert.equal(state.mode, 'nuke-running');
  assert.equal(state.store.credentials.PROVISION_SECRET, 'new-PROVISION_SECRET');
  // A full nuke cuts issued users off: no previous secret survives.
  assert.equal('PROVISION_SECRET_PREVIOUS' in state.store.credentials, false);
  assert.equal(effects[0].type, 'nuke');
  assert.equal(effects[0].kind, 'full');
});

test('nuke preserves unset optional features and clears an orphaned previous secret', () => {
  const ctx = tmpStore({ PROVISION_SECRET_PREVIOUS: 'orphaned-secret' });
  let state = { ...init(ctx), tab: 'nuke' };
  state = step(state, { type: 'NUKE_OPEN' });
  state = { ...state, nuke: { ...state.nuke, input: 'NUKE' } };
  state = step(state, td.enrich(state, { type: 'NUKE_SUBMIT' }, (key) => `new-${key}`));
  assert.equal('ADMIN_TOKEN' in state.store.credentials, false);
  assert.equal('PROVISION_SECRET' in state.store.credentials, false);
  assert.equal('PROVISION_SECRET_PREVIOUS' in state.store.credentials, false);
});

test('full nuke is blocked on custom stores and enabled for the canonical context', () => {
  let custom = { ...init(tmpStore()), tab: 'nuke', nukeCursor: 1 };
  custom = step(custom, { type: 'NUKE_OPEN' });
  assert.equal(custom.mode, 'dashboard');
  assert.match(lastMessage(custom), /custom --store/);

  const ctx = tmpStore();
  let canonical = td.initState({
    ...ctx, tab: 'nuke', canFullNuke: true,
    keyringGroups: Object.keys(cs.GROUPS)
  }, deps);
  canonical = { ...canonical, tab: 'nuke', nukeCursor: 1 };
  canonical = step(canonical, { type: 'NUKE_OPEN' });
  assert.equal(canonical.mode, 'nuke-confirm');
  assert.equal(canonical.nuke.kind, 'full');
});

test('a failed nuke restores reducer state and stays on the confirmation', () => {
  const ctx = tmpStore({ ADMIN_TOKEN: 'old-admin' });
  let state = { ...init(ctx), tab: 'nuke' };
  state = step(state, { type: 'NUKE_OPEN' });
  state = { ...state, nuke: { ...state.nuke, input: 'NUKE' } };
  state = step(state, td.enrich(state, { type: 'NUKE_SUBMIT' }, (key) => `new-${key}`));
  state = step(state, { type: 'NUKE_FAILED', message: 'disk full', rollback: ctx.store });
  assert.equal(state.mode, 'nuke-confirm');
  assert.equal(state.store.credentials.ADMIN_TOKEN, 'old-admin');
  assert.equal(state.nuke.error, 'disk full');
});

// ---------- reveal ----------

test('the reveal is gated: cancel prints nothing, confirm exits to print', () => {
  const ctx = tmpStore();
  let state = init(ctx);

  state = step(state, { type: 'REVEAL_OPEN' });
  assert.equal(state.mode, 'reveal-confirm');
  assert.ok(state.reveal.fly.keys.includes('UUID'), 'names what is about to print');
  assert.ok(!visibleJson(state).includes(ctx.store.credentials.UUID),
    'the confirm modal itself holds no value');

  // any key but y cancels
  assert.deepEqual(td.keymap(state, 'n', {}), { type: 'REVEAL_CANCEL' });
  const cancelled = step(state, { type: 'REVEAL_CANCEL' });
  assert.equal(cancelled.mode, 'dashboard');
  assert.equal(cancelled.exit, null);
  assert.match(lastMessage(cancelled), /nothing printed/);

  // y hands the printing to the post-teardown step — never to a frame
  const effects = [];
  const confirmed = step(state, { type: 'REVEAL_CONFIRM' }, { effects });
  assert.deepEqual(effects, [{ type: 'exit', code: 0 }]);
  assert.equal(confirmed.exit.post, 'reveal');
  assert.ok(!visibleJson(confirmed).includes(ctx.store.credentials.UUID));
});

test('reveal with nothing pushable reports instead of prompting', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tui-')), 'credentials.json');
  const store = cs.emptyStore();
  cs.writeStore(p, store);

  let state = init({ storePath: p, store });
  state = step(state, { type: 'REVEAL_OPEN' });
  assert.equal(state.mode, 'dashboard');
  assert.match(lastMessage(state), /nothing to push/);
});

// ---------- exports, probe, misc actions ----------

test('e emits the export effect; the file writing itself is the tested helpers', () => {
  const state = init(tmpStore());
  const effects = [];
  step(state, { type: 'EXPORT' }, { effects });
  assert.deepEqual(effects, [{ type: 'export-envs' }]);
});

test('the envs tab lists the four targets with names, files, and vars but no values', () => {
  const groups = Object.keys(cs.GROUPS);
  const state = { ...td.initState({ ...tmpStore(), keyringGroups: groups }, deps), tab: 'envs' };
  const vs = td.visibleState(state);

  assert.equal(vs.activeGroup, null, 'the envs tab has no field rows');
  assert.deepEqual(vs.envs.rows.map((r) => r.platform), ['fly', 'docker', 'wrangler', 'deno']);

  const worker = vs.envs.rows.find((r) => r.platform === 'wrangler');
  assert.equal(worker.title, 'Cloudflare Worker');
  assert.equal(worker.filename, 'worker.env');
  assert.deepEqual(worker.vars, ['SECRETS_KEY_COMMON', 'SECRETS_KEY_EDGE']);
  assert.equal(worker.disabled, false);

  assert.equal(vs.tabs.find((t) => t.name === 'envs').danger, false);
});

test('the envs tab: navigation, and enter/y copy the selected target', () => {
  const groups = Object.keys(cs.GROUPS);
  let state = { ...td.initState({ ...tmpStore(), keyringGroups: groups }, deps), tab: 'envs' };

  assert.equal(state.envsCursor, 0);
  assert.deepEqual(td.keymap(state, '', { return: true }), { type: 'COPY_ENV' });
  assert.deepEqual(td.keymap(state, 'y', {}), { type: 'COPY_ENV' });
  assert.deepEqual(td.keymap(state, 'j', {}), { type: 'MOVE', delta: 1 });

  // Move onto the second target (docker) and copy it.
  state = step(state, { type: 'MOVE', delta: 1 });
  assert.equal(state.envsCursor, 1);
  const effects = [];
  step(state, { type: 'COPY_ENV' }, { effects });
  assert.deepEqual(effects, [{ type: 'copy-env', platform: 'docker' }]);

  // MOVE wraps within the four targets.
  const wrapped = step(state, { type: 'MOVE', delta: -2 });
  assert.equal(wrapped.envsCursor, 3);
});

test('copying a target refuses when its keyring groups are missing', () => {
  // Only common present: wrangler/deno need edge, fly/docker need server.
  let state = { ...td.initState({ ...tmpStore(), keyringGroups: ['common'] }, deps), tab: 'envs' };
  const vs = td.visibleState(state);
  assert.ok(vs.envs.rows.every((r) => r.disabled), 'every target is disabled without a complete keyring');

  const effects = [];
  state = step(state, { type: 'COPY_ENV' }, { effects });   // fly selected
  assert.equal(effects.length, 0, 'nothing is copied');
  assert.match(lastMessage(state), /keyring is missing server/);
});

test('entering the envs tab triggers a freshness check and nulls the old status', () => {
  const groups = Object.keys(cs.GROUPS);
  let state = td.initState({ ...tmpStore(), keyringGroups: groups }, deps);
  state = { ...state, tab: 'config', envsStatus: { fly: 'ok', docker: 'ok', wrangler: 'ok', deno: 'ok' } };

  const effects = [];
  const entered = step(state, { type: 'TAB_MOVE', delta: 1 }, { effects });   // config → envs
  assert.equal(entered.tab, 'envs');
  assert.equal(entered.envsStatus, null, 'the stale status is cleared until re-checked');
  assert.deepEqual(effects, [{ type: 'check-envs' }]);

  // Leaving the tab emits no check.
  const left = step(entered, { type: 'TAB_MOVE', delta: 1 }, { effects: [] });
  assert.notEqual(left.tab, 'envs');
});

test('envs freshness surfaces per-row status, a stale count, and the update hint', () => {
  const groups = Object.keys(cs.GROUPS);
  let state = { ...td.initState({ ...tmpStore(), keyringGroups: groups }, deps), tab: 'envs' };

  // Before any check, rows read "checking…" and the bar has no update hint.
  let vs = td.visibleState(state);
  assert.deepEqual(vs.envs.rows.map((r) => r.freshness), ['checking…', 'checking…', 'checking…', 'checking…']);
  assert.equal(vs.envs.staleCount, 0);
  assert.ok(!vs.helpBar.includes('u update'));

  // A status map with two out of date drives the labels, count, and hint.
  state = step(state, { type: 'ENVS_STATUS', status: { fly: 'ok', docker: 'stale', wrangler: 'missing', deno: 'ok' } });
  vs = td.visibleState(state);
  const byPlatform = Object.fromEntries(vs.envs.rows.map((r) => [r.platform, r.freshness]));
  assert.deepEqual(byPlatform, { fly: 'up to date', docker: 'stale', wrangler: 'not written', deno: 'up to date' });
  assert.equal(vs.envs.staleCount, 2);
  assert.ok(vs.envs.rows.find((r) => r.platform === 'docker').stale);
  assert.match(vs.helpBar, /u update \(2 out of date\)/);
});

test('u updates the env files only when something is stale, then re-checks', () => {
  const groups = Object.keys(cs.GROUPS);
  let state = { ...td.initState({ ...tmpStore(), keyringGroups: groups }, deps), tab: 'envs' };
  assert.deepEqual(td.keymap(state, 'u', {}), { type: 'UPDATE_ENVS' });

  // All up to date → no write, a dim note instead.
  state = step(state, { type: 'ENVS_STATUS', status: { fly: 'ok', docker: 'ok', wrangler: 'ok', deno: 'ok' } });
  let effects = [];
  state = step(state, { type: 'UPDATE_ENVS' }, { effects });
  assert.equal(effects.length, 0);
  assert.match(lastMessage(state), /already up to date/);

  // Something stale → rewrite all four, then re-check.
  state = step(state, { type: 'ENVS_STATUS', status: { fly: 'ok', docker: 'stale', wrangler: 'ok', deno: 'ok' } });
  effects = [];
  step(state, { type: 'UPDATE_ENVS' }, { effects });
  assert.deepEqual(effects, [{ type: 'export-envs' }, { type: 'check-envs' }]);
});

test('the probe runs once at a time and resets on completion', () => {
  let state = init(tmpStore());
  const effects = [];
  state = step(state, { type: 'FRONT_PIN' }, { effects });
  assert.equal(state.probe, 'pending');
  state = step(state, { type: 'FRONT_PIN' }, { effects });
  assert.equal(effects.length, 1, 'a second press while pending is ignored');
  state = step(state, { type: 'PROBE_DONE' });
  assert.equal(state.probe, 'idle');
});

test('LOG lines are stripped of ANSI before they reach the message bar', () => {
  let state = init(tmpStore());
  state = step(state, { type: 'LOG', text: '\x1b[2m  wrote local/deno.env\x1b[0m' });
  assert.equal(lastMessage(state), '  wrote local/deno.env');
});

// ---------- quick setup ----------

test('quick setup generates, offers the server secrets, then walks the hosts', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tui-')), 'credentials.json');
  const store = cs.emptyStore();
  cs.writeStore(p, store);
  const ctx = { storePath: p, store };

  let state = init(ctx);
  assert.ok(td.visibleState(state).setupAvailable, 'an empty store is offered the setup');

  // S: the missing generatable required fields are filled in one action
  const start = td.enrich(state, td.keymap(state, 'S', {}), cs.generate);
  assert.deepEqual(Object.keys(start.values).sort(), ['UUID', 'WSPATH']);
  state = step(state, start, { ctx });

  const afterGen = cs.readStore(p).credentials;
  assert.equal(cs.validateField('UUID', afterGen.UUID), null, 'written through');
  assert.equal(cs.validateField('WSPATH', afterGen.WSPATH), null);

  // then the optional server secrets are offered as one y/N
  assert.equal(state.mode, 'setup-secrets');
  const secrets = td.enrich(state, { type: 'SETUP_SECRETS', yes: true }, cs.generate);
  assert.deepEqual(Object.keys(secrets.values).sort(), ['ADMIN_TOKEN', 'PROVISION_SECRET']);
  state = step(state, secrets, { ctx });
  assert.ok(cs.readStore(p).credentials.ADMIN_TOKEN);

  // then the walk: FLY_HOST first, WORKER_HOST second, then done
  assert.equal(state.mode, 'edit');
  assert.equal(state.edit.key, 'FLY_HOST');
  state = typeText(state, 'fly.example.dev');
  state = step(state, { type: 'SUBMIT' }, { ctx });

  assert.equal(state.edit.key, 'WORKER_HOST');
  state = typeText(state, 'worker.example.dev');
  state = step(state, { type: 'SUBMIT' }, { ctx });

  assert.equal(state.mode, 'dashboard');
  assert.match(lastMessage(state), /setup complete/);
  assert.equal(cs.validateStore(cs.readStore(p)).length, 0, 'the store renders after setup');
});

test('declining the server secrets still walks the hosts, and esc abandons the walk', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tui-')), 'credentials.json');
  const store = cs.emptyStore();
  cs.writeStore(p, store);
  const ctx = { storePath: p, store };

  let state = init(ctx);
  state = step(state, td.enrich(state, { type: 'SETUP_START' }, cs.generate), { ctx });
  state = step(state, { type: 'SETUP_SECRETS', yes: false }, { ctx });

  assert.equal('ADMIN_TOKEN' in cs.readStore(p).credentials, false, 'declined secrets stay unset');
  assert.equal(state.edit.key, 'FLY_HOST', 'the host walk still happens');

  state = step(state, { type: 'CANCEL' });
  assert.equal(state.mode, 'dashboard');
  assert.equal(state.setup, false, 'esc abandons the rest of the walk');
});

test('an empty submit during the walk skips to the next field', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tui-')), 'credentials.json');
  const store = cs.emptyStore();
  cs.writeStore(p, store);
  const ctx = { storePath: p, store };

  let state = init(ctx);
  state = step(state, td.enrich(state, { type: 'SETUP_START' }, cs.generate), { ctx });
  state = step(state, { type: 'SETUP_SECRETS', yes: false }, { ctx });

  assert.equal(state.edit.key, 'FLY_HOST');
  state = step(state, { type: 'SUBMIT' }, { ctx });     // skip
  assert.equal(state.edit.key, 'WORKER_HOST', 'the walk moves on');
});

// ---------- the sentinel ----------

test('no secret value ever reaches anything the components render', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tui-')), 'credentials.json');
  const store = cs.emptyStore();
  for (const f of cs.FIELDS) store.credentials[f.key] = `SENTINEL-${f.key}-VALUE`;
  cs.writeStore(p, store);

  let state = init({ storePath: p, store });
  // Walk it through every renderable mode — and every tab, since only the
  // active tab's fields reach a frame.
  const states = [];
  let walk = state;
  for (let i = 0; i < td.TABS.length; i++) {
    states.push(walk);
    walk = step(walk, { type: 'TAB_MOVE', delta: 1 });
  }
  states.push(step(at(state, 'ADMIN_TOKEN'), { type: 'OPEN_EDIT' }));
  states.push(step(at(state, 'INTERCEPT_CA_FILE'), { type: 'OPEN_EDIT' }));
  states.push(step(state, { type: 'REVEAL_OPEN' }));

  for (const s of states) {
    const text = visibleJson(s);
    const shown = td.visibleState(s).activeGroup?.rows.map((r) => r.key) || [];
    for (const f of cs.FIELDS) {
      if (shown.includes(f.key)) {
        assert.ok(text.includes(f.key), `${f.key} must appear in its tab`);
      }
      if (f.secret) {
        assert.ok(!text.includes(`SENTINEL-${f.key}-VALUE`), `${f.key} leaked into a frame`);
      }
    }
  }
});
