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

const at = (state, key) => ({ ...state, cursor: cs.FIELDS.findIndex((f) => f.key === key) });
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

test('the cursor wraps around both ends of the list', () => {
  const last = cs.FIELDS.length - 1;
  const state = init(tmpStore());

  // k on the first field lands on the last.
  assert.equal(step(state, { type: 'MOVE', delta: -1 }).cursor, last);
  // j on the last field lands on the first.
  assert.equal(step({ ...state, cursor: last }, { type: 'MOVE', delta: 1 }).cursor, 0);
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

  // fix a typo and submit, without retyping the whole host
  state = step(state, { type: 'BACKSPACE' });
  state = typeText(state, 'v');
  state = step(state, { type: 'SUBMIT' }, { ctx });
  assert.equal(cs.readStore(ctx.storePath).credentials.FLY_HOST, 'fly.example.dev'.slice(0, -1) + 'v');
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
  // Walk it through every renderable mode.
  const states = [state];
  states.push(step(at(state, 'ADMIN_TOKEN'), { type: 'OPEN_EDIT' }));
  states.push(step(at(state, 'INTERCEPT_CA_FILE'), { type: 'OPEN_EDIT' }));
  states.push(step(state, { type: 'REVEAL_OPEN' }));

  for (const s of states) {
    const text = visibleJson(s);
    for (const f of cs.FIELDS) {
      assert.ok(f.key === 'INTERCEPT_CA_FILE' || text.includes(`"${f.key}"`) || text.includes(f.key),
        `${f.key} must appear in the dashboard`);
      if (f.secret) {
        assert.ok(!text.includes(`SENTINEL-${f.key}-VALUE`), `${f.key} leaked into a frame`);
      }
    }
  }
});
