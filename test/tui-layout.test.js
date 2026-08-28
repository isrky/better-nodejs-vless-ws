'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let renderToString;
let h;
let Ui;
let td;
let cs;

test.before(async () => {
  ({ renderToString } = await import('ink'));
  ({ h } = await import('../tools/tui/h.mjs'));
  ({ Ui } = await import('../tools/tui/components.mjs'));
  td = await import('../tools/tui/reducer.mjs');
  cs = await import('../tools/credstore.mjs');
});

const stripAnsi = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const width = (text) => Array.from(stripAnsi(text)).length;

function stateFixture() {
  const store = cs.emptyStore();
  Object.assign(store.credentials, {
    UUID: '00000000-0000-4000-8000-000000000001',
    WSPATH: '/a-very-long-websocket-path-that-must-never-push-the-status-column',
    FLY_HOST: 'an-unusually-long-fly-hostname.example.invalid',
    WORKER_HOST: 'an-unusually-long-worker-hostname.example.invalid',
    ADMIN_TOKEN: 'secret-admin-token-that-must-not-render',
    PROVISION_SECRET: 'secret-provision-token-that-must-not-render',
    USERS: Array.from({ length: 12 }, (_, index) => `user-${index}`).join(' '),
    PROXYIP: 'proxy-with-a-long-name.example.invalid',
    FRONT_SNI: 'front-with-a-long-name.example.invalid',
    FRONT_PORT: '443',
    FRONT_CERT_PIN: 'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
  });
  return td.initState({
    store,
    storePath: '/tmp/credentials.json',
    pathLabel: '/a/path/whose/length/used/to/overwrite/the/problem-and-probe-indicators/credentials.json',
    keyringGroups: Object.keys(cs.GROUPS)
  }, { warnings: () => ['a long warning that must stay inside the status viewport'] });
}

function states() {
  const base = stateFixture();
  const fieldStates = td.TABS.filter((tab) => tab !== 'nuke').map((tab) => {
    const cursor = cs.FIELDS.findIndex((field) => td.tabOfKey(field.key) === tab);
    return [tab, { ...base, tab, cursor }];
  });
  const proxy = cs.FIELDS.findIndex((field) => field.key === 'PROXYIP');
  return [
    ...fieldStates,
    ['envs tab', { ...base, tab: 'envs', keyringGroups: Object.keys(cs.GROUPS),
      envsStatus: { fly: 'ok', docker: 'stale', wrangler: 'missing', deno: 'ok' } }],
    ['envs tab (no keyring)', { ...base, tab: 'envs', keyringGroups: [] }],
    ['nuke choices', { ...base, tab: 'nuke' }],
    ['editor', { ...base, tab: 'edge', cursor: proxy, mode: 'edit', edit: {
      key: 'PROXYIP', buffer: 'a-long-edited-hostname.example.invalid', caret: 18, error: null
    } }],
    ['users list', { ...base, tab: 'server', mode: 'users', users: {
      view: 'list', cursor: 11, draft: null, confirm: null, error: null
    } }],
    ['users add', { ...base, tab: 'server', mode: 'users', users: {
      view: 'input', kind: 'add', cursor: 0,
      draft: { buffer: 'a-very-long-new-user-label', caret: 12, error: null },
      confirm: null, error: null
    } }],
    ['users rename confirm', { ...base, tab: 'server', mode: 'users', users: {
      view: 'confirm', cursor: 0, draft: null,
      confirm: { kind: 'rename', target: 'user-0', replacement: 'renamed-user' }, error: null
    } }],
    ['users delete confirm', { ...base, tab: 'server', mode: 'users', users: {
      view: 'confirm', cursor: 0, draft: null,
      confirm: { kind: 'delete', target: 'user-0' }, error: null
    } }],
    ['CA selector', { ...base, mode: 'ca-select', caCursor: 2 }],
    ['reveal confirmation', { ...base, mode: 'reveal-confirm', reveal: {
      count: 8,
      fly: { name: 'a-very-long-fly-application-name', keys: ['UUID', 'WSPATH', 'ADMIN_TOKEN'] },
      worker: { name: 'a-very-long-worker-name', keys: ['UUID', 'WSPATH', 'PROVISION_SECRET'] }
    } }],
    ['setup prompt', { ...base, mode: 'setup-secrets' }],
    ['nuke confirmation', { ...base, tab: 'nuke', mode: 'nuke-confirm', nuke: {
      kind: 'full', input: 'NUKE', error: 'a deliberately long confirmation error that has to truncate'
    } }],
    ['nuke running', { ...base, tab: 'nuke', mode: 'nuke-running', nuke: { kind: 'full' } }],
    ['nuke complete', { ...base, tab: 'nuke', mode: 'nuke-done', nuke: {
      kind: 'full', encrypted: true, rotatedFields: cs.FIELDS.map((field) => field.key)
    } }],
    ['help top', { ...base, showHelp: true, helpCursor: 0 }],
    ['help bottom', { ...base, showHelp: true, helpCursor: 13 }]
  ];
}

function renderState(state, viewport) {
  return renderToString(h(Ui, { vs: td.visibleState(state), viewport }), { columns: viewport.columns });
}

test('every TUI mode stays inside representative terminal viewports', () => {
  const viewports = [
    { columns: 50, rows: 16 },
    { columns: 60, rows: 20 },
    { columns: 80, rows: 24 },
    { columns: 120, rows: 32 }
  ];

  for (const [name, state] of states()) {
    for (const viewport of viewports) {
      const output = renderState(state, viewport);
      const lines = output.split('\n');
      assert.ok(lines.length <= viewport.rows,
        `${name} emitted ${lines.length} rows into ${viewport.columns}×${viewport.rows}`);
      for (const [index, line] of lines.entries()) {
        assert.ok(width(line) <= viewport.columns,
          `${name} row ${index + 1} emitted ${width(line)} columns into ${viewport.columns}`);
      }
    }
  }
});

test('undersized terminals show only a safe resize notice', () => {
  const state = stateFixture();
  const output = stripAnsi(renderState(state, { columns: 49, rows: 15 }));
  assert.match(output, /resize terminal/);
  assert.match(output, /50×16/);
  assert.doesNotMatch(output, /credentials\.json|UUID|secret-admin-token/);
  assert.ok(output.split('\n').length <= 15);
  assert.ok(output.split('\n').every((line) => width(line) <= 49));
});

test('modal and help bodies replace dashboard fields', () => {
  const base = stateFixture();
  const proxy = cs.FIELDS.findIndex((field) => field.key === 'PROXYIP');
  const editor = { ...base, tab: 'edge', cursor: proxy, mode: 'edit', edit: {
    key: 'PROXYIP', buffer: '', error: null
  } };
  const editorOutput = stripAnsi(renderState(editor, { columns: 80, rows: 24 }));
  assert.match(editorOutput, /PROXYIP/);
  assert.doesNotMatch(editorOutput, /FRONT_CERT_PIN/);

  const helpOutput = stripAnsi(renderState({ ...base, showHelp: true }, { columns: 80, rows: 24 }));
  assert.match(helpOutput, /switch between the tabs/);
  assert.doesNotMatch(helpOutput, /group key held by/);
});

test('the compact field window keeps the selected row visible', () => {
  const base = stateFixture();
  const indices = cs.FIELDS
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => td.tabOfKey(field.key) === 'config');
  const { field, index } = indices.at(-1);
  const output = stripAnsi(renderState({ ...base, tab: 'config', cursor: index }, { columns: 50, rows: 16 }));
  assert.ok(output.includes(`› ${field.key}`), `selected ${field.key} was clipped out of the compact body`);
});

test('editor and user-list cursors remain visible at compact width', () => {
  const base = stateFixture();
  const editor = { ...base, mode: 'edit', edit: {
    key: 'FLY_HOST', buffer: 'left-side-right-side', caret: 9, error: null
  } };
  const edited = stripAnsi(renderState(editor, { columns: 50, rows: 16 }));
  assert.match(edited, /left-side▌-right-side/);

  const users = { ...base, mode: 'users', users: {
    view: 'list', cursor: 11, draft: null, confirm: null, error: null
  } };
  const listed = stripAnsi(renderState(users, { columns: 50, rows: 16 }));
  assert.match(listed, /› user-11/);
});

test('help scrolling is clamped and changes the visible window', () => {
  let state = stateFixture();
  state = td.reduce(state, { type: 'TOGGLE_HELP' }).state;
  assert.deepEqual(td.keymap(state, 'j', {}), { type: 'HELP_MOVE', delta: 1 });
  assert.deepEqual(td.keymap(state, '', { pageDown: true }), { type: 'HELP_MOVE', delta: 5 });

  state = td.reduce(state, { type: 'HELP_MOVE', delta: 100 }).state;
  assert.equal(state.helpCursor, td.visibleState(state).legend.length - 1);
  assert.equal(td.visibleState(state).legend.at(-1).selected, true);
  assert.match(stripAnsi(renderState(state, { columns: 50, rows: 16 })), /› q\s+quit/);
  state = td.reduce(state, { type: 'HELP_MOVE', delta: -100 }).state;
  assert.equal(state.helpCursor, 0);
});

test('the interactive renderer uses Ink alternate-screen mode', async () => {
  const { TUI_RENDER_OPTIONS } = await import('../tools/tui/index.mjs');
  assert.deepEqual(TUI_RENDER_OPTIONS, { exitOnCtrlC: false, alternateScreen: true });
});
