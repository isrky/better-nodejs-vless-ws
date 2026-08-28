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
  pushPlan, publicHostWarnings, platformNames, generate,
  GROUPS, PLATFORM_GROUPS, PLATFORM_META, groupOf, DEFAULT_STORE_PATH,
  parseUserLabels, validateUserLabel, maxUserLabels
} from '../credstore.mjs';

const defaultDeps = { warnings: publicHostWarnings, names: platformNames };

const MAX_MESSAGES = 4;
const CA_KEY = 'INTERCEPT_CA_FILE';
const USERS_KEY = 'USERS';
// Offered (not forced) by quick setup: a deployment without provisioning is
// legitimate, which is why these are optional in the schema.
const SETUP_SECRET_KEYS = ['ADMIN_TOKEN', 'PROVISION_SECRET'];
const NUKE_CHOICES = ['soft', 'full'];
const NUKE_GENERATABLE_FIELDS = FIELDS.filter((f) => f.secret && f.generate);

// The tabs: one per encryption group, then 'config' for the fields no group
// can hold — per-deployment values that differ per target, which is exactly
// why they are not shared secrets. Derived from the schema, so a new group in
// credstore.mjs grows the tab bar here without any further change.
export const TABS = [...Object.keys(GROUPS), 'config', 'envs', 'push', 'nuke'];

// The deployment targets the envs tab lists, in a stable order.
const ENVS_TARGETS = Object.keys(PLATFORM_GROUPS);

/** The tab a field belongs to: its encryption group, or 'config'. */
export const tabOfKey = (key) => groupOf(key) || 'config';

const tabIndices = (tab) => FIELDS
  .map((f, index) => ({ f, index }))
  .filter(({ f }) => tabOfKey(f.key) === tab)
  .map(({ index }) => index);

/** The platforms that hold a group's key — where it has to be set once. */
const platformsOfGroup = (group) => Object.entries(PLATFORM_GROUPS)
  .filter(([, groups]) => groups.includes(group))
  .map(([platform]) => platform);

export function initState({
  store, storePath, pathLabel, keyringGroups = [],
  canFullNuke = storePath === DEFAULT_STORE_PATH
}, deps = defaultDeps) {
  return {
    storePath,
    pathLabel: pathLabel || storePath,
    store,
    keyringGroups,       // group names present in the local keyring → their keys can be revealed
    tab: TABS[0],        // the active tab; the cursor always sits inside it
    tabCursors: {},      // per-tab last cursor, so switching back returns where the operator left
    cursor: 0,
    nukeCursor: 0,
    envsCursor: 0,
    envsStatus: null,   // per-target env-file freshness map, filled by the check-envs effect
    gitStatus: null,    // secrets-file git state { file, branch, upstream, ahead, behind }, filled by git-status
    gitBusy: false,     // a commit+push is in flight
    canFullNuke,
    mode: 'dashboard',   // dashboard | field/user editors | confirms | nuke states
    nuke: null,          // { kind, input, error, rotatedFields? }
    edit: null,          // { key, buffer, caret, error }
    users: null,         // { view, cursor, draft?, confirm?, error? }
    caCursor: 0,
    setup: false,        // inside the quick-setup walk
    setupQueue: [],      // required fields the walk has still to visit
    messages: [],        // [{ text, level: info|dim|error }]
    probe: 'idle',
    showHelp: false,
    helpCursor: 0,
    warnings: deps.warnings(store),
    reveal: null,
    exit: null           // { code, post: null | 'reveal' | 'keys' }
  };
}

// Lines arriving from shared helpers (exportKeyEnvs etc.) may carry ANSI from
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

function writeUsers(state, labels, cursor, deps, note) {
  const nextUsers = {
    view: 'list',
    cursor: Math.max(0, Math.min(Math.max(0, labels.length - 1), cursor)),
    draft: null,
    confirm: null,
    error: null
  };
  const { state: written, effect } = writeThrough(
    { ...state, mode: 'users', users: nextUsers },
    USERS_KEY,
    labels.length ? labels.join(' ') : null,
    deps,
    note
  );
  return { state: written, effects: [effect] };
}

function caCursorFor(store) {
  const cur = store.credentials[CA_KEY];
  return cur === undefined ? 0 : cur === '' ? 1 : 2;
}

const labelsIn = (store) => parseUserLabels(store.credentials[USERS_KEY]).labels;
const blankDraft = (buffer = '') => ({ buffer, caret: buffer.length, error: null });

function changeDraft(draft, action) {
  if (!draft) return draft;
  const caret = Math.max(0, Math.min(draft.buffer.length, draft.caret ?? draft.buffer.length));
  switch (action.type) {
    case 'INPUT_CHAR':
    case 'USERS_INPUT':
      return {
        ...draft,
        buffer: draft.buffer.slice(0, caret) + action.text + draft.buffer.slice(caret),
        caret: caret + action.text.length,
        error: null
      };
    case 'BACKSPACE':
    case 'USERS_BACKSPACE':
      if (caret === 0) return draft;
      return {
        ...draft,
        buffer: draft.buffer.slice(0, caret - 1) + draft.buffer.slice(caret),
        caret: caret - 1,
        error: null
      };
    case 'DELETE_FORWARD':
    case 'USERS_DELETE_FORWARD':
      if (caret >= draft.buffer.length) return draft;
      return {
        ...draft,
        buffer: draft.buffer.slice(0, caret) + draft.buffer.slice(caret + 1),
        error: null
      };
    case 'CLEAR_BUFFER':
    case 'USERS_CLEAR_INPUT':
      return { ...draft, buffer: '', caret: 0, error: null };
    case 'MOVE_CARET':
    case 'USERS_MOVE_CARET': {
      const next = action.to === 'home'
        ? 0
        : action.to === 'end'
          ? draft.buffer.length
          : caret + action.delta;
      return { ...draft, caret: Math.max(0, Math.min(draft.buffer.length, next)), error: null };
    }
    default:
      return draft;
  }
}

function openUsers(state, confirmClear = false) {
  const parsed = parseUserLabels(state.store.credentials[USERS_KEY]);
  const labels = parsed.labels;
  const invalid = parsed.rejected.length ? `invalid entries ignored: ${parsed.rejected.join(', ')}` : null;
  return {
    ...state,
    tab: tabOfKey(USERS_KEY),
    mode: 'users',
    edit: null,
    users: {
      view: confirmClear && labels.length ? 'confirm' : 'list',
      cursor: 0,
      draft: null,
      confirm: confirmClear && labels.length ? { kind: 'clear', count: labels.length } : null,
      error: confirmClear && !labels.length ? 'no users are configured' : invalid
    }
  };
}

function openField(state, key) {
  // The tab follows the field so closing the editor returns the setup walk to
  // the field it just handled. Editors themselves replace the dashboard body.
  const base = { ...state, tab: tabOfKey(key) };
  if (key === USERS_KEY) return openUsers(base);
  if (key === CA_KEY) return { ...base, mode: 'ca-select', caCursor: caCursorFor(state.store) };
  return { ...base, mode: 'edit', edit: { key, ...blankDraft() } };
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
  if (action.type === 'NUKE_SUBMIT' && state.nuke?.input?.toUpperCase() === 'NUKE' && !action.values) {
    const values = {};
    for (const f of NUKE_GENERATABLE_FIELDS) {
      if (f.required || state.store.credentials[f.key] !== undefined) values[f.key] = gen(f.key);
    }
    return { type: 'NUKE_SUBMIT', values };
  }
  return action;
}

function applyNukeValues(store, values, kind) {
  const oldProvision = store.credentials.PROVISION_SECRET;
  let updated = store;
  for (const [key, value] of Object.entries(values || {})) updated = withField(updated, key, value);
  // A soft nuke demotes the current provisioning secret so already-issued users
  // keep working through the cutover. A full nuke is a total reset — old group
  // keys and ciphertext are discarded — so the previous secret is cleared too,
  // cutting every issued user off until they are reissued.
  const previous = kind === 'full' ? null : (oldProvision ?? null);
  updated = withField(updated, 'PROVISION_SECRET_PREVIOUS', previous);
  return updated;
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
      if (state.tab === 'nuke') {
        const n = NUKE_CHOICES.length;
        return only({ ...state, nukeCursor: ((state.nukeCursor + action.delta) % n + n) % n });
      }
      if (state.tab === 'envs') {
        const n = ENVS_TARGETS.length;
        return only({ ...state, envsCursor: ((state.envsCursor + action.delta) % n + n) % n });
      }
      if (state.tab === 'push') return only(state);   // a single status panel, nothing to move over
      // Wrap around within the active tab: a tab is a complete view of its
      // fields, so k past the top returns to the tab's bottom rather than
      // drifting into another group. (A cursor outside its tab cannot happen
      // through the reducer; the fallback snaps it back to the tab's first.)
      const indices = tabIndices(state.tab);
      const pos = indices.indexOf(state.cursor);
      const cursor = pos === -1
        ? indices[0]
        : indices[(pos + action.delta + indices.length) % indices.length];
      return only({ ...state, cursor });
    }

    case 'TAB_MOVE': {
      // Switch tabs, wrapping. The cursor of the tab being left is remembered,
      // so switching back returns the operator to the field they were on.
      const n = TABS.length;
      const from = TABS.indexOf(state.tab);
      const tab = TABS[((from + action.delta) % n + n) % n];
      const indices = tabIndices(tab);
      const saved = state.tabCursors[tab];
      const cursor = (tab === 'nuke' || tab === 'envs' || tab === 'push') ? state.cursor : (indices.includes(saved) ? saved : indices[0]);
      const next = {
        ...state,
        tab,
        cursor,
        mode: 'dashboard',
        nuke: null,
        users: null,
        // Re-check freshness/git state on every entry so changes since the last
        // visit are caught; null shows 'checking…'.
        envsStatus: tab === 'envs' ? null : state.envsStatus,
        gitStatus: tab === 'push' ? null : state.gitStatus,
        tabCursors: { ...state.tabCursors, [state.tab]: state.cursor }
      };
      const entry = tab === 'envs' ? [{ type: 'check-envs' }]
        : tab === 'push' ? [{ type: 'git-status' }]
          : [];
      return { state: next, effects: entry };
    }

    case 'OPEN_EDIT':
      if (state.tab === 'nuke') return only(state);
      return only(openField(state, FIELDS[state.cursor].key));

    case 'NUKE_OPEN': {
      if (state.tab !== 'nuke') return only(state);
      const kind = NUKE_CHOICES[state.nukeCursor];
      if (kind === 'full' && !state.canFullNuke) {
        return only(say(state, 'full nuke is disabled for a custom --store', 'error'));
      }
      return only({ ...state, mode: 'nuke-confirm', nuke: { kind, input: '', error: null } });
    }

    case 'NUKE_INPUT':
      if (state.mode !== 'nuke-confirm') return only(state);
      return only({ ...state, nuke: { ...state.nuke, input: state.nuke.input + action.text, error: null } });

    case 'NUKE_BACKSPACE':
      if (state.mode !== 'nuke-confirm') return only(state);
      return only({ ...state, nuke: { ...state.nuke, input: state.nuke.input.slice(0, -1), error: null } });

    case 'NUKE_CLEAR':
      if (state.mode !== 'nuke-confirm') return only(state);
      return only({ ...state, nuke: { ...state.nuke, input: '', error: null } });

    case 'NUKE_CANCEL':
      return only({ ...state, mode: 'dashboard', nuke: null });

    case 'NUKE_SUBMIT': {
      if (state.mode !== 'nuke-confirm') return only(state);
      if (state.nuke.input.toUpperCase() !== 'NUKE') {
        return only({ ...state, nuke: { ...state.nuke, error: 'type NUKE to continue' } });
      }
      if (!action.values) return only(state);
      const rollback = state.store;
      const store = applyNukeValues(state.store, action.values, state.nuke.kind);
      return {
        state: {
          ...state,
          store,
          mode: 'nuke-running',
          warnings: deps.warnings(store),
          nuke: { ...state.nuke, input: '', error: null, rotatedFields: Object.keys(action.values) }
        },
        effects: [{ type: 'nuke', kind: state.nuke.kind, store, rollback }]
      };
    }

    case 'NUKE_OK':
      return only({
        ...state,
        mode: 'nuke-done',
        keyringGroups: action.keyringGroups || state.keyringGroups,
        nuke: { ...state.nuke, encrypted: action.encrypted }
      });

    case 'NUKE_FAILED':
      return only({
        ...say({ ...state, store: action.rollback, warnings: deps.warnings(action.rollback) }, action.message, 'error'),
        mode: 'nuke-confirm',
        nuke: { ...state.nuke, input: '', error: action.message, rotatedFields: undefined }
      });

    case 'INPUT_CHAR': {
      if (!state.edit) return only(state);
      return only({ ...state, edit: changeDraft(state.edit, action) });
    }

    case 'BACKSPACE': {
      if (!state.edit) return only(state);
      return only({ ...state, edit: changeDraft(state.edit, action) });
    }

    case 'DELETE_FORWARD': {
      if (!state.edit) return only(state);
      return only({ ...state, edit: changeDraft(state.edit, action) });
    }

    case 'MOVE_CARET': {
      if (!state.edit) return only(state);
      return only({ ...state, edit: changeDraft(state.edit, action) });
    }

    case 'CLEAR_BUFFER': {
      if (!state.edit) return only(state);
      return only({ ...state, edit: changeDraft(state.edit, action) });
    }

    case 'LOAD_CURRENT': {
      // Pull the stored value into the buffer to edit in place rather than
      // retype it — shell-history style. A masked secret stays masked in the
      // display; an unset field has nothing to load.
      if (!state.edit) return only(state);
      const current = state.store.credentials[state.edit.key];
      if (typeof current !== 'string' || current === '') return only(state);
      return only({ ...state, edit: { ...state.edit, buffer: current, caret: current.length, error: null } });
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

    case 'USERS_MOVE': {
      if (state.mode !== 'users' || state.users?.view !== 'list') return only(state);
      const labels = labelsIn(state.store);
      if (!labels.length) return only(state);
      const cursor = ((state.users.cursor + action.delta) % labels.length + labels.length) % labels.length;
      return only({ ...state, users: { ...state.users, cursor, error: null } });
    }

    case 'USERS_ADD': {
      if (state.mode !== 'users' || state.users?.view !== 'list') return only(state);
      if (labelsIn(state.store).length >= maxUserLabels()) {
        return only({ ...state, users: { ...state.users, error: `maximum ${maxUserLabels()} users reached` } });
      }
      return only({ ...state, users: { ...state.users, view: 'input', kind: 'add', draft: blankDraft(), error: null } });
    }

    case 'USERS_RENAME': {
      if (state.mode !== 'users' || state.users?.view !== 'list') return only(state);
      const labels = labelsIn(state.store);
      const target = labels[state.users.cursor];
      if (!target) return only({ ...state, users: { ...state.users, error: 'no user selected' } });
      return only({
        ...state,
        users: { ...state.users, view: 'input', kind: 'rename', target, draft: blankDraft(target), error: null }
      });
    }

    case 'USERS_DELETE': {
      if (state.mode !== 'users' || state.users?.view !== 'list') return only(state);
      const target = labelsIn(state.store)[state.users.cursor];
      if (!target) return only({ ...state, users: { ...state.users, error: 'no user selected' } });
      return only({
        ...state,
        users: { ...state.users, view: 'confirm', confirm: { kind: 'delete', target }, error: null }
      });
    }

    case 'USERS_CLEAR_ALL': {
      if (state.mode !== 'users' || state.users?.view !== 'list') return only(state);
      const count = labelsIn(state.store).length;
      if (!count) return only({ ...state, users: { ...state.users, error: 'no users are configured' } });
      return only({
        ...state,
        users: { ...state.users, view: 'confirm', confirm: { kind: 'clear', count }, error: null }
      });
    }

    case 'USERS_INPUT':
    case 'USERS_BACKSPACE':
    case 'USERS_DELETE_FORWARD':
    case 'USERS_CLEAR_INPUT':
    case 'USERS_MOVE_CARET':
      if (state.mode !== 'users' || state.users?.view !== 'input') return only(state);
      return only({ ...state, users: { ...state.users, draft: changeDraft(state.users.draft, action) } });

    case 'USERS_SUBMIT': {
      if (state.mode !== 'users' || state.users?.view !== 'input') return only(state);
      const labels = labelsIn(state.store);
      const { label, error } = validateUserLabel(state.users.draft.buffer);
      if (error) {
        return only({ ...state, users: { ...state.users, draft: { ...state.users.draft, error } } });
      }
      const target = state.users.target;
      if (labels.includes(label) && label !== target) {
        return only({
          ...state,
          users: { ...state.users, draft: { ...state.users.draft, error: `${label} already exists` } }
        });
      }
      if (state.users.kind === 'add') {
        return writeUsers(state, [...labels, label], labels.length, deps,
          `user ${label} added — commit and redeploy to activate`);
      }
      if (label === target) {
        return only({
          ...state,
          users: { ...state.users, view: 'list', draft: null, target: null, kind: null, error: null }
        });
      }
      return only({
        ...state,
        users: {
          ...state.users,
          view: 'confirm',
          draft: null,
          confirm: { kind: 'rename', target, replacement: label },
          error: null
        }
      });
    }

    case 'USERS_CONFIRM': {
      if (state.mode !== 'users' || state.users?.view !== 'confirm') return only(state);
      if (!action.yes) {
        return only({
          ...state,
          users: { ...state.users, view: 'list', confirm: null, draft: null, target: null, kind: null, error: null }
        });
      }
      const labels = labelsIn(state.store);
      const confirm = state.users.confirm;
      if (confirm.kind === 'rename') {
        const index = labels.indexOf(confirm.target);
        if (index === -1) return only({ ...state, users: { ...state.users, view: 'list', confirm: null, error: 'user no longer exists' } });
        const next = [...labels];
        next[index] = confirm.replacement;
        return writeUsers(state, next, index, deps,
          `user ${confirm.target} renamed to ${confirm.replacement} — commit and redeploy to revoke the old identity`);
      }
      if (confirm.kind === 'delete') {
        const index = labels.indexOf(confirm.target);
        if (index === -1) {
          return only({ ...state, users: { ...state.users, view: 'list', confirm: null, error: 'user no longer exists' } });
        }
        const next = labels.filter((label) => label !== confirm.target);
        return writeUsers(state, next, Math.min(index, next.length - 1), deps,
          `user ${confirm.target} deleted — commit and redeploy to revoke access`);
      }
      if (confirm.kind === 'clear') {
        return writeUsers(state, [], 0, deps,
          `all ${labels.length} users deleted — commit and redeploy to revoke access`);
      }
      return only({ ...state, users: { ...state.users, view: 'list', confirm: null, error: 'unknown confirmation' } });
    }

    case 'USERS_CANCEL':
      if (state.mode !== 'users') return only(state);
      if (state.users?.view === 'list') {
        return only({ ...state, mode: 'dashboard', users: null });
      }
      return only({
        ...state,
        users: { ...state.users, view: 'list', draft: null, confirm: null, target: null, kind: null, error: null }
      });

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
      if (f.key === USERS_KEY) return only(openUsers(state, true));
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
        return only({ ...state, mode: 'ca-path', edit: { key: CA_KEY, ...blankDraft() } });
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

    case 'COPY_ENV': {
      // Copy the selected target's group-key block to the clipboard. The values
      // are read from the keyring at effect time, never held in this state.
      if (state.tab !== 'envs') return only(state);
      const platform = ENVS_TARGETS[state.envsCursor];
      const missing = PLATFORM_GROUPS[platform].filter((g) => !state.keyringGroups.includes(g));
      if (missing.length) {
        return only(say(state, `keyring is missing ${missing.join(', ')} — run: node tools/credentials.mjs --init-keys`, 'error'));
      }
      return { state, effects: [{ type: 'copy-env', platform }] };
    }

    case 'ENVS_STATUS':
      return only({ ...state, envsStatus: action.status });

    case 'UPDATE_ENVS': {
      if (state.tab !== 'envs') return only(state);
      const stale = Object.values(state.envsStatus || {}).some((s) => s === 'stale' || s === 'missing');
      if (!stale) return only(say(state, 'env files already up to date', 'dim'));
      // Rewrite all four (the export is idempotent for the fresh ones), then re-check.
      return { state, effects: [{ type: 'export-envs' }, { type: 'check-envs' }] };
    }

    case 'GIT_STATUS':
      return only({ ...state, gitStatus: action.status });

    case 'PUSH_OPEN': {
      if (state.tab !== 'push' || state.gitBusy) return only(state);
      const s = state.gitStatus;
      if (s && s.file === 'clean' && s.ahead === 0) {
        return only(say(state, 'nothing to commit or push', 'dim'));
      }
      return only({ ...state, mode: 'push-confirm' });
    }

    case 'PUSH_CANCEL':
      return only({ ...state, mode: 'dashboard' });

    case 'PUSH_CONFIRM':
      if (state.mode !== 'push-confirm') return only(state);
      return { state: { ...state, mode: 'dashboard', gitBusy: true }, effects: [{ type: 'git-commit-push' }] };

    case 'GIT_DONE':
      // Refresh the panel after the commit+push settles.
      return { state: { ...state, gitBusy: false }, effects: [{ type: 'git-status' }] };

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

    case 'HELP_MOVE':
      return only({
        ...state,
        helpCursor: Math.max(0, Math.min(LEGEND.length - 1, state.helpCursor + action.delta))
      });

    case 'TOGGLE_HELP':
      return only({ ...state, showHelp: !state.showHelp, helpCursor: 0 });

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

  if (state.showHelp) {
    if (key.escape || input === '?') return { type: 'TOGGLE_HELP' };
    if (key.upArrow || input === 'k') return { type: 'HELP_MOVE', delta: -1 };
    if (key.downArrow || input === 'j') return { type: 'HELP_MOVE', delta: 1 };
    if (key.pageUp) return { type: 'HELP_MOVE', delta: -5 };
    if (key.pageDown) return { type: 'HELP_MOVE', delta: 5 };
    if (input === 'q') return { type: 'QUIT' };
    return null;
  }

  if (state.mode === 'users') {
    const view = state.users?.view;
    if (view === 'confirm') {
      if (input === 'y' || input === 'Y') return { type: 'USERS_CONFIRM', yes: true };
      if (input === 'n' || input === 'N' || key.escape) return { type: 'USERS_CONFIRM', yes: false };
      return null;
    }
    if (view === 'input') {
      if (key.escape) return { type: 'USERS_CANCEL' };
      if (key.return) return { type: 'USERS_SUBMIT' };
      if (key.backspace) return { type: 'USERS_BACKSPACE' };
      if (key.delete) return { type: 'USERS_DELETE_FORWARD' };
      if (key.ctrl && input === 'u') return { type: 'USERS_CLEAR_INPUT' };
      if (key.leftArrow) return { type: 'USERS_MOVE_CARET', delta: -1 };
      if (key.rightArrow) return { type: 'USERS_MOVE_CARET', delta: 1 };
      if (key.home) return { type: 'USERS_MOVE_CARET', to: 'home' };
      if (key.end) return { type: 'USERS_MOVE_CARET', to: 'end' };
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return null;
      if (input) return { type: 'USERS_INPUT', text: input };
      return null;
    }
    if (key.escape || input === 'q') return { type: 'USERS_CANCEL' };
    if (key.upArrow || input === 'k') return { type: 'USERS_MOVE', delta: -1 };
    if (key.downArrow || input === 'j') return { type: 'USERS_MOVE', delta: 1 };
    if (key.return || input === 'r') return { type: 'USERS_RENAME' };
    if (input === 'a') return { type: 'USERS_ADD' };
    if (input === 'd') return { type: 'USERS_DELETE' };
    if (input === 'D') return { type: 'USERS_CLEAR_ALL' };
    return null;
  }

  if (state.mode === 'nuke-confirm') {
    if (key.escape) return { type: 'NUKE_CANCEL' };
    if (key.return) return { type: 'NUKE_SUBMIT' };
    if (key.backspace || key.delete) return { type: 'NUKE_BACKSPACE' };
    if (key.ctrl && input === 'u') return { type: 'NUKE_CLEAR' };
    if (key.ctrl || key.meta || key.tab || key.leftArrow || key.rightArrow ||
        key.upArrow || key.downArrow || key.pageUp || key.pageDown) return null;
    if (input) return { type: 'NUKE_INPUT', text: input };
    return null;
  }

  if (state.mode === 'nuke-running') return null;

  if (state.mode === 'nuke-done') {
    if (key.escape || key.return) return { type: 'NUKE_CANCEL' };
    if (key.tab) return { type: 'TAB_MOVE', delta: key.shift ? -1 : 1 };
    if (key.leftArrow || input === 'h') return { type: 'TAB_MOVE', delta: -1 };
    if (key.rightArrow || input === 'l') return { type: 'TAB_MOVE', delta: 1 };
    if (input === 'q') return { type: 'QUIT' };
    return null;
  }

  if (state.mode === 'edit' || state.mode === 'ca-path') {
    if (key.escape) return { type: 'CANCEL' };
    if (key.return) return { type: 'SUBMIT' };
    if (key.backspace) return { type: 'BACKSPACE' };
    if (key.delete) return { type: 'DELETE_FORWARD' };
    if (key.ctrl && input === 'u') return { type: 'CLEAR_BUFFER' };
    if (key.leftArrow) return { type: 'MOVE_CARET', delta: -1 };
    if (key.rightArrow) return { type: 'MOVE_CARET', delta: 1 };
    if (key.home) return { type: 'MOVE_CARET', to: 'home' };
    if (key.end) return { type: 'MOVE_CARET', to: 'end' };
    if (key.upArrow) return { type: 'LOAD_CURRENT' };
    if (key.ctrl || key.meta || key.tab ||
        key.downArrow || key.pageUp || key.pageDown) return null;
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

  if (state.mode === 'push-confirm') {
    if (input === 'y' || input === 'Y') return { type: 'PUSH_CONFIRM' };
    return { type: 'PUSH_CANCEL' };
  }

  if (state.mode === 'setup-secrets') {
    if (input === 'y' || input === 'Y') return { type: 'SETUP_SECRETS', yes: true };
    return { type: 'SETUP_SECRETS', yes: false };
  }

  // dashboard
  if (key.upArrow || input === 'k') return { type: 'MOVE', delta: -1 };
  if (key.downArrow || input === 'j') return { type: 'MOVE', delta: 1 };
  if (key.tab) return { type: 'TAB_MOVE', delta: key.shift ? -1 : 1 };
  if (key.leftArrow || input === 'h') return { type: 'TAB_MOVE', delta: -1 };
  if (key.rightArrow || input === 'l') return { type: 'TAB_MOVE', delta: 1 };
  if (key.return) {
    if (state.tab === 'nuke') return { type: 'NUKE_OPEN' };
    if (state.tab === 'envs') return { type: 'COPY_ENV' };
    if (state.tab === 'push') return { type: 'PUSH_OPEN' };
    return { type: 'OPEN_EDIT' };
  }
  if (state.tab === 'envs') {
    if (input === 'y' || input === 'c') return { type: 'COPY_ENV' };
    if (input === 'u') return { type: 'UPDATE_ENVS' };
    if (input === '?') return { type: 'TOGGLE_HELP' };
    if (input === 'q') return { type: 'QUIT' };
    return null;
  }
  if (state.tab === 'push') {
    if (input === '?') return { type: 'TOGGLE_HELP' };
    if (input === 'q') return { type: 'QUIT' };
    return null;
  }
  if (state.tab === 'nuke') {
    if (input === '?') return { type: 'TOGGLE_HELP' };
    if (input === 'q') return { type: 'QUIT' };
    return null;
  }
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
  if (state.showHelp) return '↑↓/jk scroll · pgup/pgdn jump · ?/esc close · q quit';
  if (state.mode === 'users') {
    if (state.users?.view === 'input') {
      return '←→ move cursor · home/end · enter continue · esc cancel · ctrl-u clear';
    }
    if (state.users?.view === 'confirm') return 'y confirm · n/esc cancel';
    return '↑↓/jk move · a add · enter/r rename · d delete · D delete all · esc back';
  }

  switch (state.mode) {
    case 'edit':
    case 'ca-path': {
      const current = state.edit && state.store.credentials[state.edit.key];
      const load = (typeof current === 'string' && current !== '') ? ' · ↑ edit current' : '';
      return '←→ cursor · home/end · enter save (empty = keep) · esc cancel · ctrl-u clear' + load;
    }
    case 'ca-select':
      return '↑↓/jk move · enter choose · 1/2/3 pick · esc back';
    case 'reveal-confirm':
      return 'y print and exit · any other key cancel';
    case 'push-confirm':
      return 'y commit & push · any other key cancel';
    case 'setup-secrets':
      return 'y generate · n skip';
    case 'nuke-confirm':
      return 'type NUKE · enter rotate · esc cancel · ctrl-u clear';
    case 'nuke-running':
      return 'rotating — do not quit';
    case 'nuke-done':
      return 'enter/esc reset · ←→/hl tabs · q quit';
    default: {
      if (state.tab === 'nuke') {
        return '↑↓/jk choose · enter select · ←→/hl tabs · ? help · q quit';
      }
      if (state.tab === 'envs') {
        const stale = Object.values(state.envsStatus || {}).filter((s) => s === 'stale' || s === 'missing').length;
        const update = stale ? ` · u update (${stale} out of date)` : '';
        return '↑↓/jk choose · enter/y copy' + update + ' · ←→/hl tabs · ? help · q quit';
      }
      if (state.tab === 'push') {
        return state.gitBusy
          ? 'pushing — do not quit'
          : 'enter commit & push · ←→/hl tabs · ? help · q quit';
      }
      // Only advertise a keypress that would actually do something on the
      // highlighted field — pressing g on FRONT_SNI or c on UUID is a red
      // "cannot" message, so the hint for it is noise.
      const f = FIELDS[state.cursor];
      const hints = ['↑↓/jk move', '←→/hl tabs'];
      hints.push(f.key === CA_KEY
        ? 'enter choose CA'
        : f.key === USERS_KEY
          ? 'enter manage users'
          : 'enter edit');
      if (f.generate) hints.push('g generate');
      if (!f.required && state.store.credentials[f.key] !== undefined) {
        hints.push(f.key === USERS_KEY ? 'c delete all' : 'c clear');
      }
      if (setupAvailable) hints.push('S setup');
      hints.push('p reveal');
      hints.push('e export', 'f pin', 'u undo', '? help', 'q quit');
      return hints.join(' · ');
    }
  }
}

const LEGEND = [
  ['←→ / h l / tab', 'switch between the tabs (one per env group, then per-deployment config)'],
  ['↑↓ / j k', "move between the tab's fields"],
  ['enter', 'edit the highlighted field (CA chooses a source; USERS opens its manager)'],
  ['g', 'generate a fresh value for the highlighted field, written through'],
  ['c', 'clear the highlighted optional field (USERS confirms deleting everyone)'],
  ['S', 'quick setup: generate what can be generated, then walk the required hosts'],
  ['p', 'reveal the secrets to paste into the dashboards (confirms, then exits)'],
  ['e', 'export the four group-key env files (0600, no values announced)'],
  ['f', 'probe the VPS edge and print FRONT_CERT_PIN'],
  ['u', 'undo the last change (restores the .bak)'],
  ['r', 'how to render the client configs'],
  ['envs tab', "copy a target's group-key block to the clipboard; u rewrites stale files"],
  ['push tab', 'commit and push src/node/secrets.enc.json to the remote'],
  ['nuke tab', 'soft rotates credentials; full also replaces every encryption-group key'],
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

  const tabLabel = (tab) => tab === 'config'
    ? 'per-deployment config — never encrypted, set per platform'
    : tab === 'nuke'
      ? 'assume compromise — rotate credentials or credentials + encryption keys'
      : tab === 'envs'
        ? "group-key env files — copy a target's block to the clipboard"
        : tab === 'push'
          ? 'commit and push the encrypted secrets to the remote'
          : `${tab} — group key held by ${platformsOfGroup(tab).join(', ')}`;

  // The tab bar: problems are counted per tab so a missing required field is
  // visible from every tab, not only the one it lives on.
  const tabs = TABS.map((tab) => ({
    name: tab,
    label: tabLabel(tab),
    active: tab === state.tab,
    danger: tab === 'nuke',
    problems: tabIndices(tab).filter((index) => problems.has(FIELDS[index].key)).length
  }));

  // Only the active tab's fields reach a frame — the tab is a complete view,
  // not a filter over a shared list.
  const row = (index) => {
    const f = FIELDS[index];
    const problem = problems.get(f.key);
    return {
      key: f.key,
      display: redact(f.key, store.credentials[f.key]),
      status: problem ? problem.reason : (store.credentials[f.key] === undefined ? '' : 'ok'),
      error: Boolean(problem),
      targets: f.pushTo.length ? '→ ' + f.pushTo.join(', ') : '',
      selected: index === state.cursor
    };
  };
  const activeGroup = (state.tab === 'nuke' || state.tab === 'envs' || state.tab === 'push') ? null : {
    label: tabLabel(state.tab),
    rows: tabIndices(state.tab).map(row)
  };

  // The envs tab: which target is selected, which env-var names it needs, and
  // whether its keyring groups exist. Never the key values — those are read at
  // effect time when a row is copied, so no secret enters a frame.
  const FRESHNESS = { ok: 'up to date', stale: 'stale', missing: 'not written' };
  let envs = null;
  if (state.tab === 'envs') {
    const rows = ENVS_TARGETS.map((platform, index) => {
      const groups = PLATFORM_GROUPS[platform];
      const missing = groups.filter((g) => !state.keyringGroups.includes(g));
      const disabled = missing.length > 0;
      const status = state.envsStatus?.[platform] ?? null;
      return {
        platform,
        title: PLATFORM_META[platform].title,
        filename: PLATFORM_META[platform].envFile,
        vars: groups.map((g) => 'SECRETS_KEY_' + g.toUpperCase()),
        selected: index === state.envsCursor,
        disabled,
        missing,
        status,
        stale: status === 'stale' || status === 'missing',
        freshness: FRESHNESS[status] ?? (disabled ? '' : 'checking…')
      };
    });
    envs = { label: tabLabel('envs'), rows, staleCount: rows.filter((r) => r.stale).length };
  }

  // The push tab: the git state of the secrets file. Branch names, counts, and
  // enums only — the file's ciphertext is never read into a frame.
  let push = null;
  if (state.tab === 'push') {
    const s = state.gitStatus;
    push = {
      label: tabLabel('push'),
      file: 'src/node/secrets.enc.json',
      status: s,
      busy: state.gitBusy,
      confirm: state.mode === 'push-confirm',
      nothingToDo: s ? (s.file === 'clean' && s.ahead === 0) : false
    };
  }

  let nuke = null;
  if (state.tab === 'nuke') {
    const kind = state.nuke?.kind;
    nuke = {
      label: tabLabel('nuke'),
      mode: state.mode,
      choices: NUKE_CHOICES.map((name, index) => ({
        name,
        selected: index === state.nukeCursor,
        disabled: name === 'full' && !state.canFullNuke,
        description: name === 'soft'
          ? 'rotate every active credential; keep encryption-group keys'
          : 'rotate every active credential and every encryption-group key'
      })),
      confirm: state.mode === 'nuke-confirm' ? {
        kind,
        input: state.nuke.input,
        error: state.nuke.error
      } : null,
      running: state.mode === 'nuke-running',
      done: state.mode === 'nuke-done' ? {
        kind,
        rotatedFields: state.nuke.rotatedFields || [],
        encrypted: state.nuke.encrypted,
        steps: kind === 'full'
          ? [
              'From a network outside the tunnel, reveal and set the new group keys on all four platforms.',
              'Commit and push src/node/secrets.enc.json, then redeploy every target as one coordinated cutover.',
              'Run npm run configs, npm run qr, and npm run configs:check; re-import every client.'
            ]
          : [
              state.nuke.encrypted
                ? 'Commit and push src/node/secrets.enc.json, then redeploy every target.'
                : 'Use p reveal to update plaintext deployments, or initialize the encrypted-secrets keyring first.',
              'Run npm run configs, npm run qr, and npm run configs:check.',
              'Re-import every client; the old UUID stops working when deployments receive this rotation.'
            ]
      } : null
    };
  }

  let editor = null;
  if (state.edit) {
    const f = field(state.edit.key);
    const secret = Boolean(f && f.secret);
    const len = state.edit.buffer.length;
    const caret = Math.max(0, Math.min(len, state.edit.caret ?? len));
    editor = {
      key: state.edit.key,
      help: f ? f.help : '',
      current: redact(state.edit.key, store.credentials[state.edit.key]),
      display: len === 0 ? '' : secret ? '•'.repeat(Math.min(len, 24)) + ` (${len} chars)` : state.edit.buffer,
      input: {
        before: secret ? '•'.repeat(caret) : state.edit.buffer.slice(0, caret),
        after: (secret ? '•'.repeat(len - caret) : state.edit.buffer.slice(caret)) +
          (secret && len ? ` (${len} chars)` : '')
      },
      empty: len === 0,
      secret,
      error: state.edit.error,
      setup: state.setup
    };
  }

  let userManager = null;
  if (state.mode === 'users' && state.users) {
    const labels = labelsIn(store);
    const draft = state.users.draft;
    const caret = draft ? Math.max(0, Math.min(draft.buffer.length, draft.caret)) : 0;
    userManager = {
      view: state.users.view,
      kind: state.users.kind || null,
      count: labels.length,
      limit: maxUserLabels(),
      provisioning: Boolean(store.credentials.PROVISION_SECRET),
      rows: labels.map((label, index) => ({ label, selected: index === state.users.cursor })),
      input: draft ? {
        before: draft.buffer.slice(0, caret),
        after: draft.buffer.slice(caret),
        empty: draft.buffer.length === 0,
        error: draft.error
      } : null,
      confirm: state.users.confirm || null,
      error: state.users.error
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
    tabs,
    activeGroup,
    envs,
    push,
    nuke,
    warnings: state.warnings,
    setupAvailable,
    editor,
    userManager,
    caSelect,
    reveal: state.mode === 'reveal-confirm' ? state.reveal : null,
    setupSecrets: state.mode === 'setup-secrets'
      ? { keys: SETUP_SECRET_KEYS.filter((k) => store.credentials[k] === undefined) }
      : null,
    messages: state.messages,
    probe: state.probe,
    showHelp: state.showHelp,
    legend: state.showHelp
      ? LEGEND.map(([keys, what], index) => ({ keys, what, selected: index === state.helpCursor }))
      : null,
    helpBar: helpBar(state, setupAvailable)
  };
}
