// The dashboard's entire behaviour as a pure state machine.
//
// reduce() never touches the filesystem, the terminal, or crypto: writes and
// probes leave as effect descriptors, generated values arrive inside action
// payloads (enrich() attaches them at the dispatch site), so every flow the
// old scripted-menu tests drove can be asserted here without rendering a
// frame. The two read-only repo lookups (fly.toml drift, platform names) come
// in through `deps` and are stubbable.
//
// visibleState() is the only bridge to the components: field values pass
// through redact(), and a secret editor buffer renders as a mask. That keeps
// "no frame ever contains a secret" a property of this module rather than a
// discipline asked of every component.

import {
  FIELDS, field, redact, validateField, validateStore, withField,
  pushPlan, publicHostWarnings, platformNames, generate
} from '../credstore.mjs';

const defaultDeps = { warnings: publicHostWarnings, names: platformNames };

const MAX_MESSAGES = 4;
const CA_KEY = 'INTERCEPT_CA_FILE';
// Offered (not forced) by quick setup: a deployment without provisioning is
// legitimate, which is why these are optional in the schema.
const SETUP_SECRET_KEYS = ['ADMIN_TOKEN', 'PROVISION_SECRET'];

export function initState({ store, storePath, pathLabel }, deps = defaultDeps) {
  return {
    storePath,
    pathLabel: pathLabel || storePath,
    store,
    cursor: 0,
    mode: 'dashboard',   // dashboard | edit | ca-select | ca-path | reveal-confirm | setup-secrets
    edit: null,          // { key, buffer, error }
    caCursor: 0,
    setup: false,        // inside the quick-setup walk
    setupQueue: [],      // required fields the walk has still to visit
    messages: [],        // [{ text, level: info|dim|error }]
    probe: 'idle',
    showHelp: false,
    warnings: deps.warnings(store),
    reveal: null,
    exit: null           // { code, post: null | 'reveal' }
  };
}

// Lines arriving from shared helpers (exportDenoEnv etc.) may carry ANSI from
// their CLI life; Ink does its own styling, so strip rather than re-measure.
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function say(state, text, level = 'info') {
  return { ...state, messages: [...state.messages, { text: stripAnsi(text), level }].slice(-MAX_MESSAGES) };
}

const only = (state, effects = []) => ({ state, effects });

/**
 * Apply one field change optimistically and emit the write-through effect.
 * The rollback copy rides on the effect so a failed write can revert exactly.
 */
function writeThrough(state, key, value, deps, note) {
  const rollback = state.store;
  const updated = withField(state.store, key, value);
  const next = { ...state, store: updated, warnings: deps.warnings(updated) };
  const text = note ||
    `${key} ${value === null ? 'cleared' : 'set'} — ${redact(key, updated.credentials[key])}`;
  return {
    state: say(next, text),
    effect: { type: 'write-store', store: updated, rollback }
  };
}

function caCursorFor(store) {
  const cur = store.credentials[CA_KEY];
  return cur === undefined ? 0 : cur === '' ? 1 : 2;
}

function openField(state, key) {
  if (key === CA_KEY) return { ...state, mode: 'ca-select', caCursor: caCursorFor(state.store) };
  return { ...state, mode: 'edit', edit: { key, buffer: '', error: null } };
}

const missingRequired = (store) =>
  FIELDS.filter((f) => f.required && store.credentials[f.key] === undefined).map((f) => f.key);

/** Begin the quick-setup walk over whatever required fields are still unset. */
function startWalk(state) {
  return advanceWalk({ ...state, setup: true, setupQueue: missingRequired(state.store) });
}

/**
 * Open the next queued field, or finish. The queue is explicit rather than
 * recomputed so an empty submit can SKIP a field — recomputing would reopen
 * the still-missing field forever.
 */
function advanceWalk(state) {
  const queue = state.setupQueue.filter((k) => state.store.credentials[k] === undefined);
  if (!queue.length) {
    const left = missingRequired(state.store).length;
    return say(
      { ...state, mode: 'dashboard', edit: null, setup: false, setupQueue: [] },
      left
        ? `setup finished — ${left} required field(s) still unset`
        : 'setup complete — every required field is set'
    );
  }
  const [head, ...rest] = queue;
  const cursor = FIELDS.findIndex((f) => f.key === head);
  return { ...openField({ ...state, cursor, setupQueue: rest }, head), setup: true };
}

/**
 * Attach the payloads that need randomness (or the store) to an intent from
 * keymap(), so reduce() itself stays deterministic. `gen` is injectable.
 */
export function enrich(state, action, gen = generate) {
  if (!action) return action;

  if (action.type === 'GENERATE' && action.value === undefined) {
    const f = FIELDS[state.cursor];
    return { type: 'GENERATE', key: f.key, value: f.generate ? gen(f.key) : null };
  }
  if (action.type === 'SETUP_START' && !action.values) {
    const values = {};
    for (const f of FIELDS) {
      if (f.required && f.generate && state.store.credentials[f.key] === undefined) {
        values[f.key] = gen(f.key);
      }
    }
    return { type: 'SETUP_START', values };
  }
  if (action.type === 'SETUP_SECRETS' && action.yes && !action.values) {
    const values = {};
    for (const key of SETUP_SECRET_KEYS) {
      if (state.store.credentials[key] === undefined) values[key] = gen(key);
    }
    return { type: 'SETUP_SECRETS', yes: true, values };
  }
  return action;
}

/** Set several fields at once (quick setup), as a single write. */
function applyValues(state, values, deps) {
  const entries = Object.entries(values || {});
  if (!entries.length) return { state, effects: [] };
  const rollback = state.store;
  let store = state.store;
  for (const [key, value] of entries) store = withField(store, key, value);
  let next = { ...state, store, warnings: deps.warnings(store) };
  for (const [key] of entries) {
    next = say(next, `${key} set — ${redact(key, store.credentials[key])}`);
  }
  return { state: next, effects: [{ type: 'write-store', store, rollback }] };
}

export function reduce(state, action, deps = defaultDeps) {
  switch (action.type) {
    case 'MOVE': {
      // Wrap around: k past the top lands on the last field, j past the
      // bottom on the first.
      const n = FIELDS.length;
      const cursor = ((state.cursor + action.delta) % n + n) % n;
      return only({ ...state, cursor });
    }

    case 'OPEN_EDIT':
      return only(openField(state, FIELDS[state.cursor].key));

    case 'INPUT_CHAR': {
      if (!state.edit) return only(state);
      return only({ ...state, edit: { ...state.edit, buffer: state.edit.buffer + action.text, error: null } });
    }

    case 'BACKSPACE': {
      if (!state.edit) return only(state);
      return only({ ...state, edit: { ...state.edit, buffer: state.edit.buffer.slice(0, -1), error: null } });
    }

    case 'CLEAR_BUFFER': {
      if (!state.edit) return only(state);
      return only({ ...state, edit: { ...state.edit, buffer: '', error: null } });
    }

    case 'LOAD_CURRENT': {
      // Pull the stored value into the buffer to edit in place rather than
      // retype it — shell-history style. A masked secret stays masked in the
      // display; an unset field has nothing to load.
      if (!state.edit) return only(state);
      const current = state.store.credentials[state.edit.key];
      if (typeof current !== 'string' || current === '') return only(state);
      return only({ ...state, edit: { ...state.edit, buffer: current, error: null } });
    }

    case 'CANCEL':
      // esc: leave the editor/submenu; during setup it abandons the walk.
      return only({ ...state, mode: 'dashboard', edit: null, reveal: null, setup: false, setupQueue: [] });

    case 'SUBMIT': {
      if (!state.edit) return only(state);
      const { key, buffer } = state.edit;

      if (buffer === '') {
        // Empty submit keeps the current value (or skips this setup step).
        const base = { ...state, mode: 'dashboard', edit: null };
        return only(state.setup ? advanceWalk(base) : base);
      }

      const why = validateField(key, buffer);
      if (why) {
        // The rejected value stays in the buffer (fix the typo) but is never
        // put anywhere visibleState would render for a secret field.
        return only({ ...state, edit: { ...state.edit, error: `${key} ${why}` } });
      }

      const { state: written, effect } =
        writeThrough({ ...state, mode: 'dashboard', edit: null }, key, buffer, deps);
      return { state: state.setup ? advanceWalk(written) : written, effects: [effect] };
    }

    case 'GENERATE': {
      if (state.mode !== 'dashboard') return only(state);
      if (action.value === null || action.value === undefined) {
        return only(say(state, `${action.key} cannot be generated`, 'error'));
      }
      const { state: written, effect } = writeThrough(state, action.key, action.value, deps);
      return { state: written, effects: [effect] };
    }

    case 'CLEAR_FIELD': {
      if (state.mode !== 'dashboard') return only(state);
      const f = FIELDS[state.cursor];
      if (f.required) {
        return only(say(state, `${f.key} is required${f.generate ? '; use g' : ''}`, 'error'));
      }
      if (state.store.credentials[f.key] === undefined) {
        return only(say(state, `${f.key} is already unset`, 'dim'));
      }
      const { state: written, effect } = writeThrough(state, f.key, null, deps);
      return { state: written, effects: [effect] };
    }

    case 'CA_MOVE': {
      const caCursor = Math.min(2, Math.max(0, state.caCursor + action.delta));
      return only({ ...state, caCursor });
    }

    case 'CA_PICK': {
      const index = action.index ?? state.caCursor;
      if (index === 2) {
        return only({ ...state, mode: 'ca-path', edit: { key: CA_KEY, buffer: '', error: null } });
      }
      const value = index === 0 ? null : '';
      const note = `${CA_KEY} — ${index === 0 ? 'bundled CA (key removed)' : 'no pinned CA'}`;
      const { state: written, effect } =
        writeThrough({ ...state, mode: 'dashboard' }, CA_KEY, value, deps, note);
      return { state: written, effects: [effect] };
    }

    case 'REVEAL_OPEN': {
      const plan = pushPlan(state.store);
      if (!plan.fly.length && !plan.wrangler.length) {
        return only(say(state, 'nothing to push — no pushable value is set', 'dim'));
      }
      const names = deps.names();
      return only({
        ...state,
        mode: 'reveal-confirm',
        reveal: {
          count: new Set([...plan.fly, ...plan.wrangler]).size,
          fly: { name: names.fly, keys: plan.fly },
          worker: { name: names.worker, keys: plan.wrangler }
        }
      });
    }

    case 'REVEAL_CANCEL':
      return only(say({ ...state, mode: 'dashboard', reveal: null }, '(nothing printed)', 'dim'));

    case 'REVEAL_CONFIRM':
      // The values are printed by runTui AFTER Ink tears down — formatReveal
      // stays the only printing site, and no frame ever holds a secret.
      return {
        state: { ...state, exit: { code: 0, post: 'reveal' } },
        effects: [{ type: 'exit', code: 0 }]
      };

    case 'EXPORT':
      return { state, effects: [{ type: 'export-envs' }] };

    case 'FRONT_PIN': {
      if (state.probe === 'pending') return only(state);
      return { state: { ...state, probe: 'pending' }, effects: [{ type: 'probe-pin' }] };
    }

    case 'PROBE_DONE':
      return only({ ...state, probe: 'idle' });

    case 'UNDO':
      return { state, effects: [{ type: 'restore-backup' }] };

    case 'UNDO_OK':
      return only(say(
        { ...state, store: action.store, warnings: deps.warnings(action.store) },
        'restored the previous store'
      ));

    case 'UNDO_FAILED':
      return only(say(state, action.message, 'error'));

    case 'RENDER_HINT':
      return only(say(state, 'run `npm run configs` to render', 'dim'));

    case 'SETUP_START': {
      if (!missingRequired(state.store).length && !Object.keys(action.values || {}).length) {
        return only(say(state, 'nothing to set up — every required field is set', 'dim'));
      }
      const { state: applied, effects } = applyValues(state, action.values, deps);
      const missingSecrets = SETUP_SECRET_KEYS.filter((k) => applied.store.credentials[k] === undefined);
      if (missingSecrets.length) {
        return { state: { ...applied, mode: 'setup-secrets', setup: true }, effects };
      }
      return { state: startWalk(applied), effects };
    }

    case 'SETUP_SECRETS': {
      const base = { ...state, mode: 'dashboard' };
      if (!action.yes) return only(startWalk(base));
      const { state: applied, effects } = applyValues(base, action.values, deps);
      return { state: startWalk(applied), effects };
    }

    case 'WRITE_OK':
      return only(state);

    case 'WRITE_FAILED':
      return only(say(
        { ...state, store: action.rollback, warnings: deps.warnings(action.rollback) },
        action.message, 'error'
      ));

    case 'LOG':
      return only(say(state, action.text, action.level || 'info'));

    case 'TOGGLE_HELP':
      return only({ ...state, showHelp: !state.showHelp });

    case 'QUIT':
      return { state: { ...state, exit: { code: 0, post: null } }, effects: [{ type: 'exit', code: 0 }] };

    case 'INTERRUPT':
      return { state: { ...state, exit: { code: 130, post: null } }, effects: [{ type: 'exit', code: 130 }] };

    default:
      return only(state);
  }
}

/** Map a raw keystroke to an action (or null), per mode. Pure. */
export function keymap(state, input, key) {
  if (key.ctrl && input === 'c') return { type: 'INTERRUPT' };

  if (state.mode === 'edit' || state.mode === 'ca-path') {
    if (key.escape) return { type: 'CANCEL' };
    if (key.return) return { type: 'SUBMIT' };
    if (key.backspace || key.delete) return { type: 'BACKSPACE' };
    if (key.ctrl && input === 'u') return { type: 'CLEAR_BUFFER' };
    if (key.upArrow || key.downArrow) return { type: 'LOAD_CURRENT' };
    if (key.ctrl || key.meta || key.tab ||
        key.leftArrow || key.rightArrow ||
        key.pageUp || key.pageDown) return null;
    if (input) return { type: 'INPUT_CHAR', text: input };
    return null;
  }

  if (state.mode === 'ca-select') {
    if (key.escape || input === 'q') return { type: 'CANCEL' };
    if (key.return) return { type: 'CA_PICK' };
    if (key.upArrow || input === 'k') return { type: 'CA_MOVE', delta: -1 };
    if (key.downArrow || input === 'j') return { type: 'CA_MOVE', delta: 1 };
    if (input === '1' || input === '2' || input === '3') {
      return { type: 'CA_PICK', index: Number(input) - 1 };
    }
    return null;
  }

  if (state.mode === 'reveal-confirm') {
    if (input === 'y' || input === 'Y') return { type: 'REVEAL_CONFIRM' };
    return { type: 'REVEAL_CANCEL' };
  }

  if (state.mode === 'setup-secrets') {
    if (input === 'y' || input === 'Y') return { type: 'SETUP_SECRETS', yes: true };
    return { type: 'SETUP_SECRETS', yes: false };
  }

  // dashboard
  if (key.upArrow || input === 'k') return { type: 'MOVE', delta: -1 };
  if (key.downArrow || input === 'j') return { type: 'MOVE', delta: 1 };
  if (key.return) return { type: 'OPEN_EDIT' };
  if (input === 'g') return { type: 'GENERATE' };
  if (input === 'c') return { type: 'CLEAR_FIELD' };
  if (input === 'p') return { type: 'REVEAL_OPEN' };
  if (input === 'e') return { type: 'EXPORT' };
  if (input === 'f') return { type: 'FRONT_PIN' };
  if (input === 'u') return { type: 'UNDO' };
  if (input === 'r') return { type: 'RENDER_HINT' };
  if (input === 's' || input === 'S') return { type: 'SETUP_START' };
  if (input === '?') return { type: 'TOGGLE_HELP' };
  if (input === 'q') return { type: 'QUIT' };
  return null;
}

function helpBar(state, setupAvailable) {
  switch (state.mode) {
    case 'edit':
    case 'ca-path': {
      const current = state.edit && state.store.credentials[state.edit.key];
      const load = (typeof current === 'string' && current !== '') ? ' · ↑ edit current' : '';
      return 'enter save (empty = keep) · esc cancel · ctrl-u clear' + load;
    }
    case 'ca-select':
      return '↑↓/jk move · enter choose · 1/2/3 pick · esc back';
    case 'reveal-confirm':
      return 'y print and exit · any other key cancel';
    case 'setup-secrets':
      return 'y generate · n skip';
    default: {
      // Only advertise a keypress that would actually do something on the
      // highlighted field — pressing g on FRONT_SNI or c on UUID is a red
      // "cannot" message, so the hint for it is noise.
      const f = FIELDS[state.cursor];
      const hints = ['↑↓/jk move'];
      hints.push(f.key === CA_KEY ? 'enter choose CA' : 'enter edit');
      if (f.generate) hints.push('g generate');
      if (!f.required && state.store.credentials[f.key] !== undefined) hints.push('c clear');
      if (setupAvailable) hints.push('S setup');
      hints.push('p reveal', 'e export', 'f pin', 'u undo', '? help', 'q quit');
      return hints.join(' · ');
    }
  }
}

const LEGEND = [
  ['↑↓ / j k', 'move between fields'],
  ['enter', 'edit the highlighted field (CA opens a 3-way choice)'],
  ['g', 'generate a fresh value for the highlighted field, written through'],
  ['c', 'clear the highlighted optional field'],
  ['S', 'quick setup: generate what can be generated, then walk the required hosts'],
  ['p', 'reveal the secrets to paste into the dashboards (confirms, then exits)'],
  ['e', 'export local/deno.env and local/docker.env (0600, names announced, no values)'],
  ['f', 'probe the VPS edge and print FRONT_CERT_PIN'],
  ['u', 'undo the last change (restores the .bak)'],
  ['r', 'how to render the client configs'],
  ['q', 'quit']
];

/**
 * Everything the components are allowed to render. Field values pass through
 * redact(); a secret editor buffer becomes a mask. Nothing else in the state
 * reaches the screen.
 */
export function visibleState(state) {
  const { store } = state;
  const problems = new Map(validateStore(store).map((p) => [p.key, p]));
  const setupAvailable = missingRequired(store).length > 0;

  const groups = ['render', 'server'].map((group) => ({
    label: group === 'render'
      ? 'used to render the client configs'
      : 'server-side only — never written into a config',
    rows: FIELDS
      .map((f, index) => ({ f, index }))
      .filter(({ f }) => f.group === group)
      .map(({ f, index }) => {
        const problem = problems.get(f.key);
        return {
          key: f.key,
          display: redact(f.key, store.credentials[f.key]),
          status: problem ? problem.reason : (store.credentials[f.key] === undefined ? '' : 'ok'),
          error: Boolean(problem),
          targets: f.pushTo.length ? '→ ' + f.pushTo.join(', ') : '',
          selected: index === state.cursor
        };
      })
  }));

  let editor = null;
  if (state.edit) {
    const f = field(state.edit.key);
    const secret = Boolean(f && f.secret);
    const len = state.edit.buffer.length;
    editor = {
      key: state.edit.key,
      help: f ? f.help : '',
      current: redact(state.edit.key, store.credentials[state.edit.key]),
      display: len === 0 ? '' : secret ? '•'.repeat(Math.min(len, 24)) + ` (${len} chars)` : state.edit.buffer,
      empty: len === 0,
      secret,
      error: state.edit.error,
      setup: state.setup
    };
  }

  let caSelect = null;
  if (state.mode === 'ca-select') {
    const cur = store.credentials[CA_KEY];
    caSelect = {
      cursor: state.caCursor,
      options: [
        { label: 'bundled — the root from src/node/interceptca.js', current: cur === undefined },
        { label: 'none — omit the certificates block entirely', current: cur === '' },
        { label: 'file — supply your own PEM' + (cur ? `  (current: ${cur})` : ''), current: Boolean(cur) }
      ]
    };
  }

  return {
    header: { path: state.pathLabel, version: store.version, problems: problems.size },
    groups,
    warnings: state.warnings,
    setupAvailable,
    editor,
    caSelect,
    reveal: state.mode === 'reveal-confirm' ? state.reveal : null,
    setupSecrets: state.mode === 'setup-secrets'
      ? { keys: SETUP_SECRET_KEYS.filter((k) => store.credentials[k] === undefined) }
      : null,
    messages: state.messages,
    probe: state.probe,
    showHelp: state.showHelp,
    legend: state.showHelp ? LEGEND : null,
    helpBar: helpBar(state, setupAvailable)
  };
}
