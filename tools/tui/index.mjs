// Mount the dashboard, wait for it to tear down, then do whatever the exit
// asked for. The reveal in particular happens HERE, after Ink has restored
// the terminal: formatReveal stays the only place a secret prints, the values
// land in normal scrollback rather than an Ink frame, and a repaint can never
// clobber them.
import { render } from 'ink';
import { h } from './h.mjs';
import { App } from './app.mjs';
import { readKeyring } from '../credsecrets.mjs';

export const TUI_RENDER_OPTIONS = Object.freeze({ exitOnCtrlC: false, alternateScreen: true });

export async function runTui({ storePath, store, pathLabel }) {
  const result = { code: 0, post: null, store };
  // Only the group NAMES cross into the TUI — the key material itself stays
  // out of the reducer state, exactly like every other secret.
  const keyring = readKeyring();
  const keyringGroups = keyring ? Object.keys(keyring) : [];
  const instance = render(
    h(App, { storePath, store, pathLabel, keyringGroups, result }),
    TUI_RENDER_OPTIONS
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
