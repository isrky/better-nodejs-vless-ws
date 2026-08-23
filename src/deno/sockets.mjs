// Deno stand-in for Cloudflare's `cloudflare:sockets` module. The Deno entry
// aliases the bare specifier `cloudflare:sockets` to this file via the import
// map in deno.json, so src/worker/relay.mjs and src/worker/mux.mjs import it
// unchanged.
//
// The Worker socket exposes { opened, readable, writable, close }. Deno.connect
// returns a Deno.Conn with .readable/.writable Web streams and a synchronous
// .close(), and the connect() call itself is the async part — so `opened` is
// just that promise. readable/writable are only ever touched after the caller
// has awaited `opened`, which is why the getters can assume `conn` is set.

export function connect({ hostname, port }) {
  let conn = null;
  const opened = Deno.connect({ hostname, port }).then((c) => { conn = c; });
  return {
    opened,
    get readable() { return conn.readable; },
    get writable() { return conn.writable; },
    // Cloudflare's close() returns a promise the callers swallow with
    // ignoreRejection(); Deno's is synchronous and can throw if the socket is
    // already torn down, so guard it and hand back a settled promise to keep
    // the ignoreRejection(...) call sites happy.
    close() {
      try { conn?.close(); } catch {}
      return Promise.resolve();
    }
  };
}
