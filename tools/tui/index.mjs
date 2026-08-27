// Mount the dashboard, wait for it to tear down, then do whatever the exit
// asked for. The reveal in particular happens HERE, after Ink has restored
// the terminal: formatReveal stays the only place a secret prints, the values
// land in normal scrollback rather than an Ink frame, and a repaint can never
// clobber them.
import { render } from 'ink';
import { h } from './h.mjs';
import { App } from './app.mjs';

export async function runTui({ storePath, store, pathLabel }) {
  const result = { code: 0, post: null, store };
  const instance = render(h(App, { storePath, store, pathLabel, result }), { exitOnCtrlC: false });
  await instance.waitUntilExit();

  if (result.post === 'reveal') {
    const [{ formatReveal }, { pushPlan, platformNames }] = await Promise.all([
      import('../credentials.mjs'),
      import('../credstore.mjs')
    ]);
    console.log(formatReveal(pushPlan(result.store), result.store, platformNames()));
  }
  return result.code;
}
