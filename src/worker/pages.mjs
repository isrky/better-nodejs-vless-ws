// Decoy page served to anything that isn't a valid WebSocket upgrade on the
// configured path. The markup itself lives in ../decoy.js so the Node build
// and this one cannot drift — they are the same bytes by construction rather
// than by convention.
//
// Same CJS->ESM bridge as ../vless.js: esbuild hands back module.exports as
// the default export. ../decoy.js is a bare string constant touching no Node
// built-ins, so it needs no nodejs_compat flag.

import decoy from '../decoy.js';

export const FAKE_INDEX_HTML = decoy.FAKE_INDEX_HTML;

export function decoyResponse() {
  return new Response(FAKE_INDEX_HTML, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache, no-store, must-revalidate'
    }
  });
}
