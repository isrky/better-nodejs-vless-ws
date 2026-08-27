// The one stateful component: useReducer over the pure machine, a keystroke
// pipeline (useInput → keymap → enrich → dispatch), and the effect runner that
// executes what reduce() only described. All I/O funnels through the `io`
// object so a test can hand in stubs; the defaults are the same helpers the
// CLI flags use, with their output redirected into the message bar.
import { useReducer, useEffect, useRef } from 'react';
import { useApp, useInput } from 'ink';
import { html } from './h.mjs';
import { initState, reduce, keymap, enrich, visibleState } from './reducer.mjs';
import { writeStore, restoreBackup } from '../credstore.mjs';
import { exportDenoEnv, exportDockerEnv, printFrontPin } from '../credentials.mjs';
import { Ui } from './components.mjs';

const defaultIo = { writeStore, restoreBackup, exportDenoEnv, exportDockerEnv, printFrontPin };

// Effects are appended with a sequence number and executed exactly once, so
// React re-running the reducer or re-rendering cannot double-write the store.
function wrappedReducer(w, action) {
  const { state, effects } = reduce(w.state, action);
  if (!effects || !effects.length) return { ...w, state };
  let seq = w.seq;
  return { state, seq: seq + effects.length, queue: [...w.queue, ...effects.map((eff) => ({ ...eff, seq: ++seq }))] };
}

export function App({ store, storePath, pathLabel, result, io: ioProp }) {
  const { exit } = useApp();
  const io = ioProp || defaultIo;

  const [w, dispatch] = useReducer(wrappedReducer, { store, storePath, pathLabel }, (init) => ({
    state: initState(init), queue: [], seq: 0
  }));

  const stateRef = useRef(w.state);
  stateRef.current = w.state;
  const ran = useRef(0);

  async function runEffect(eff) {
    const log = (line, level) => dispatch({ type: 'LOG', text: String(line), level });
    switch (eff.type) {
      case 'write-store':
        try {
          io.writeStore(storePath, eff.store);
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
      case 'export-envs':
        try {
          log('deno.env — Deno Deploy', 'dim');
          io.exportDenoEnv(stateRef.current.store, storePath, log);
          log('docker.env — VPS compose stack', 'dim');
          io.exportDockerEnv(stateRef.current.store, storePath, log);
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
    const action = enrich(stateRef.current, keymap(stateRef.current, input, key));
    if (action) dispatch(action);
  });

  return html`<${Ui} vs=${visibleState(w.state)} />`;
}
