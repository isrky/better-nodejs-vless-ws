// Mount the dashboard, wait for it to tear down, then do whatever the exit
// asked for. The reveal in particular happens HERE, after Ink has restored
// the terminal: formatReveal stays the only place a secret prints, the values
// land in normal scrollback rather than an Ink frame, and a repaint can never
// clobber them.
import { render } from 'ink';
import { h } from './h.mjs';
import { App } from './app.mjs';
import { readKeyring } from '../credsecrets.mjs';

export async function runTui({ storePath, store, pathLabel }) {
  const result = { code: 0, post: null, store };
  const hasKeyring = readKeyring() !== null;
  const instance = render(
    h(App, { storePath, store, pathLabel, hasKeyring, result }), { exitOnCtrlC: false }
  );
  await instance.waitUntilExit();

  // Secrets (and the group keys) print HERE, after Ink restores the terminal —
  // the single printing site, in normal scrollback, never an Ink frame.
  if (result.post === 'reveal') {
    const [{ formatReveal }, { pushPlan, platformNames }] = await Promise.all([
      import('../credentials.mjs'),
      import('../credstore.mjs')
    ]);
    console.log(formatReveal(pushPlan(result.store), result.store, platformNames()));
  } else if (result.post === 'keys') {
    const { formatKeysReveal } = await import('../credentials.mjs');
    const keys = readKeyring();
    if (keys) console.log(formatKeysReveal(keys));
  }
  return result.code;
}
