// The one stateful component: useReducer over the pure machine, a keystroke
// pipeline (useInput → keymap → enrich → dispatch), and the effect runner that
// executes what reduce() only described. All I/O funnels through the `io`
// object so a test can hand in stubs; the defaults are the same helpers the
// CLI flags use, with their output redirected into the message bar.
import { useReducer, useEffect, useRef, useState } from 'react';
import { useApp, useInput, useStdout } from 'ink';
import { html } from './h.mjs';
import { initState, reduce, keymap, enrich, visibleState } from './reducer.mjs';
import { writeStore, restoreBackup, DEFAULT_STORE_PATH } from '../credstore.mjs';
import {
  exportKeyEnvs, printFrontPin, syncSecretsFile,
  commitCredentialNuke
} from '../credentials.mjs';
import { Ui, terminalTooSmall } from './components.mjs';

const defaultIo = {
  writeStore, restoreBackup, exportKeyEnvs, printFrontPin,
  syncSecretsFile, commitCredentialNuke
};

export function terminalViewport(stdout) {
  return {
    columns: Math.max(1, Number(stdout?.columns) || 80),
    rows: Math.max(1, Number(stdout?.rows) || 24)
  };
}

// Effects are appended with a sequence number and executed exactly once, so
// React re-running the reducer or re-rendering cannot double-write the store.
function wrappedReducer(w, action) {
  const { state, effects } = reduce(w.state, action);
  if (!effects || !effects.length) return { ...w, state };
  let seq = w.seq;
  return { state, seq: seq + effects.length, queue: [...w.queue, ...effects.map((eff) => ({ ...eff, seq: ++seq }))] };
}

export function App({ store, storePath, pathLabel, keyringGroups, result, io: ioProp }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const io = ioProp || defaultIo;
  const [viewport, setViewport] = useState(() => terminalViewport(stdout));

  const [w, dispatch] = useReducer(wrappedReducer, { store, storePath, pathLabel, keyringGroups }, (init) => ({
    state: initState(init), queue: [], seq: 0
  }));

  const stateRef = useRef(w.state);
  stateRef.current = w.state;
  const ran = useRef(0);

  useEffect(() => {
    const resize = () => setViewport(terminalViewport(stdout));
    stdout?.on?.('resize', resize);
    return () => stdout?.off?.('resize', resize);
  }, [stdout]);

  async function runEffect(eff) {
    const log = (line, level) => dispatch({ type: 'LOG', text: String(line), level });
    switch (eff.type) {
      case 'write-store':
        try {
          io.writeStore(storePath, eff.store);
          // Keep the committed ciphertext in step with the store. Only for the
          // canonical store — editing a scratch `--store` must never clobber the
          // repo's committed file. A no-op until a keyring exists; a failure
          // here must not lose the store write, so it only notes to the bar.
          if (storePath === DEFAULT_STORE_PATH) {
            try {
              if (io.syncSecretsFile && io.syncSecretsFile(eff.store)) {
                log('secrets.enc.json updated', 'dim');
              }
            } catch (e) {
              log(`could not update secrets.enc.json: ${e.message}`, 'error');
            }
          }
        } catch (e) {
          dispatch({ type: 'WRITE_FAILED', message: e.message, rollback: eff.rollback });
        }
        break;
      case 'restore-backup':
        try {
          dispatch({ type: 'UNDO_OK', store: io.restoreBackup(storePath) });
        } catch (e) {
          dispatch({ type: 'UNDO_FAILED', message: e.message });
        }
        break;
      case 'nuke':
        try {
          const committed = io.commitCredentialNuke(eff.store, { kind: eff.kind, storePath });
          dispatch({ type: 'NUKE_OK', ...committed });
        } catch (e) {
          dispatch({ type: 'NUKE_FAILED', message: e.message, rollback: eff.rollback });
        }
        break;
      case 'export-envs':
        try {
          io.exportKeyEnvs(storePath, log);
        } catch (e) {
          log(e.message, 'error');
        }
        break;
      case 'probe-pin':
        try {
          await io.printFrontPin(stateRef.current.store, log);
        } catch (e) {
          log(e.message, 'error');
        } finally {
          dispatch({ type: 'PROBE_DONE' });
        }
        break;
      case 'exit':
        if (result) {
          result.code = eff.code;
          result.post = stateRef.current.exit?.post || null;
          result.store = stateRef.current.store;
        }
        (io.exit || exit)();
        break;
    }
  }

  useEffect(() => {
    for (const eff of w.queue) {
      if (eff.seq <= ran.current) continue;
      ran.current = eff.seq;
      runEffect(eff);
    }
  });

  useInput((input, key) => {
    if (terminalTooSmall(viewport)) {
      if (key.ctrl && input === 'c') dispatch({ type: 'INTERRUPT' });
      else if (input === 'q') dispatch({ type: 'QUIT' });
      return;
    }
    const action = enrich(stateRef.current, keymap(stateRef.current, input, key));
    if (action) dispatch(action);
  });

  return html`<${Ui} vs=${visibleState(w.state)} viewport=${viewport} />`;
}
