# better-nodejs-vless-ws

VLESS + WebSocket proxy server for Node.js with full **xUDP** and **Mux.Cool** (xray-core multiplexing) support.

Enhanced from [eooce/node-ws](https://github.com/eooce/node-ws) (GPL-3.0) with AI assistance (Kimi K2.6).

---

## Features

- **VLESS over WebSocket** — standard VLESS protocol tunneling over WS
- **TCP proxying** — direct TCP stream forwarding
- **Legacy UDP** — UDP tunneling via VLESS framing
- **xUDP** — extended UDP multiplexing (xray-core)
- **Mux.Cool** — full xray-core connection multiplexing support
- **DNS cache** — built-in DNS resolver with TTL-based caching (300s TTL, 60s sweep)
- **Domain blocking** — Saved from [eooce/node-ws](https://github.com/eooce/node-ws) (GPL-3.0)
- **Admin dashboard** — live stats at `/admin-stats` (connections, streams, traffic, uptime)
- **Decoy page** — outputs a fake HTML page on non-proxy HTTP requests (or on failed authentication)
- **Zero-allocation hot path** — chunked buffer queue and reusable codec buffers for performance

---

## Client Compatibility

| Client | TCP | UDP / xUDP | Mux.Cool |
|---|---|---|---|
| v2rayN | ✅ | ✅ | ✅ |
| v2rayNG | ✅ | ✅ | ✅ |
| v2rayTun | ✅ | ✅ | ✅ |
| Happ | ✅ | ✅ | ✅ |
| Streisand | ✅ | ✅ | ✅ |
| NekoBox | ✅ | ✅ | ⚠️ |
| sing-box VT | ✅ | ✅ | ⚠️ |
| Hiddify | ✅ | ✅ | ⚠️ |
| Karing | ✅ | ✅ | ⚠️ |
| Shadowrocket | ✅ | ✅ | ⚠️ |

> [!CAUTION]
> **⚠️ sing-box based clients have compatibility issues with Mux.Cool.**

> [!NOTE]
> **TCP, Legacy UDP and XUDP are NOT affected by this issue**.

---

## Deployment Targets

Three builds ship from this repo, sharing the VLESS protocol parser in `src/vless.js`:

- **Node.js** (`appws.js`) — the full-featured self-hosted server. Everything below applies to it unless noted.
- **Cloudflare Workers** (`src/worker/`) — a serverless build with no VPS to run. See [Cloudflare Workers](#cloudflare-workers) for its capabilities and limits.
- **Deno Deploy** (`src/deno/`) — a second serverless build with the same capabilities and limits as the Worker (TCP + DNS-over-DoH, no UDP). It reuses the entire `src/worker/` code unchanged; only the entry (`src/deno/main.mjs`) and a `cloudflare:sockets` shim (`src/deno/sockets.mjs`) are Deno-specific. See [Deno Deploy](#deno-deploy).

---

## Requirements

- Node.js 16+
- No external npm dependencies <-- used only Node.js built-ins (`net`, `dgram`, `dns`, `crypto`)

---

## Quick Start

```bash
git clone https://github.com/cocaococao/better-nodejs-vless-ws
cd better-nodejs-vless-ws
node appws.js
```

The server starts on port `3000` by default. Check the console output for your WebSocket path and UUID.

---

## Configuration

The configuration is done through environment variables.

| Variable | Default | Description |
|---|---|---|
| `UUID` | `7bd180e8-...` | Your own VLESS UUID. Authenticates as the reserved user `owner`. |
| `WSPATH` | `/` | WebSocket path prefix |
| `PORT` / `SERVER_PORT` | `3000` | Listening port |
| `ADMIN_TOKEN` | *(unset)* | Gate for `/admin-stats`. Unset → the page is hidden (serves the decoy). Set → `?token=<ADMIN_TOKEN>` once, then a session cookie. |

Provisioning (see [Provisioning other people's devices](#provisioning-other-peoples-devices)) adds:

| Variable | Default | Description |
|---|---|---|
| `PROVISION_SECRET` | *(unset)* | Master secret each user's UUID is derived from. Unset → provisioning is off entirely and every provisioning route serves the decoy. |
| `PROVISION_SECRET_PREVIOUS` | *(unset)* | Also accepted during a secret rotation, so existing devices keep working. |
| `USERS` | *(empty)* | Comma/space separated labels, e.g. `alice,bob`. `[a-z0-9_-]`, max 32 chars, max 64 users. `owner` is reserved. |
| `PUBLIC_HOST` | *(Host header)* | Hostname written into generated configs. Effectively mandatory — see the warning on the provisioning page. |
| `PUBLIC_PORT` | `443` | Port written into generated configs. |
| `INVITE_TTL_SECONDS` | `900` | How long a minted invite stays valid. |
| `INVITE_PATH` | `/i/` | Prefix for invite links. Change it if it would collide with `WSPATH`. |
| `SESSION_TTL_SECONDS` | `43200` | Admin cookie lifetime. |
| `INTERCEPT_CA` | *(built-in)* | Override the CA embedded in generated configs. Empty string omits it. |
| `TRUST_PROXY` | auto | `1`/`0`. Auto-detected from `FLY_APP_NAME`; controls whether `X-Forwarded-Proto` and `Fly-Client-IP` are believed. |
| `DOH_URL` | *(unset)* | Resolve destination hostnames over DNS-over-HTTPS (RFC 8484) instead of the system resolver. Unset → system resolver, unchanged. |
| `DOH_TIMEOUT_MS` | `3000` | Per-query timeout before falling back. Clamped to 200–15000. |

> [!NOTE]
> `DOH_URL` covers **both** paths: UDP sends go through the existing DNS cache, and TCP connections get a `lookup` backed by the same cache — otherwise `net.createConnection` would keep using `getaddrinfo` and most lookups would quietly bypass DoH. A failure falls back to the system resolver, and after three consecutive failures a breaker stops calling out for 30 s, so a resolver outage costs one timeout rather than one per lookup.

**Example:**

```bash
UUID=your-uuid-here WSPATH=mypath PORT=8080 node appws.js
```

The table above is **server** environment. The *client* side keeps its values in
`local/credentials.json`, managed with `npm run creds` and rendered into the
configs under `local/` by `npm run configs`. See [CREDENTIALS.md](CREDENTIALS.md)
for generating each value and for the rotation order.

---

## Client Configuration

- **Protocol:** VLESS
- **Address:** your server IP or domain
- **Port:** your configured port
- **UUID:** your configured UUID (or first 8 chars of UUID)
- **Network:** WebSocket
- **WS Path:** `/<WSPATH>` (e.g. `/7bd180e8`)
- **TLS:** depends (see below)

---

## Running Behind a Reverse Proxy (TLS)

You can put this server behind nginx or Caddy to handle TLS:

**Caddy example (`Caddyfile`):**

```
yourdomain.com {
    reverse_proxy /yourpath* localhost:3000
}
```

**nginx example:**

```nginx
location /yourpath {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host $host;
}
```

---

## Deploy with Docker / Fly.io

The Node build has zero npm dependencies, so the image is tiny. A `Dockerfile` and `fly.toml` are included. Fly's edge terminates TLS and forwards plaintext WS to the container (`appws.js` auto-detects plaintext), so no reverse proxy of your own is needed — this is the plug-and-play alternative to a self-managed VPS, and unlike Cloudflare Workers it carries **UDP** (games, voice).

```bash
fly launch --no-deploy                 # adopts the committed fly.toml
fly secrets set UUID=<uuid> WSPATH=/<wspath> ADMIN_TOKEN=<token>
fly deploy
fly certs add sub.yourdomain.com       # then add the DNS records Fly prints
```

The same `Dockerfile` runs on Koyeb/Railway/Render if you prefer their free tiers. Because these forward every path (not just `/<WSPATH>`), set `ADMIN_TOKEN` so `/admin-stats` isn't world-readable.

---

## VPS with Docker Compose / Dockge

A `compose.yaml` is included for running the container on your own VPS with nginx on the host terminating TLS. It builds the image locally (nothing to pull), publishes the port on loopback only (`127.0.0.1:3000`), and sets `TRUST_PROXY=1`. With [Dockge](https://github.com/louislam/dockge), the repo *is* the stack:

```bash
cd /opt/stacks
git clone https://github.com/you/better-nodejs-vless-ws vless-ws
```

Secrets go in a `.env` next to `compose.yaml` (gitignored). On your own machine, `npm run creds:docker` writes `local/docker.env` with exactly the keys the container reads — `UUID`, `WSPATH`, `ADMIN_TOKEN`, `PROVISION_SECRET`, `USERS`, and `PUBLIC_HOST` (from the store's `VPS_HOST`) — paste its contents into Dockge's env editor, then start the stack. Optionally add `DOH_URL=` there too (deployment config rather than a credential, same as `fly.toml`'s `[env]` block). Updating is `git pull` + rebuild in Dockge; the container drains connections for up to 25 s on stop instead of hard-cutting live tunnels.

The image healthcheck probes `GET /` (served the decoy, always 200), so Dockge shows real health.

Your nginx server block needs the WebSocket headers from the [reverse proxy section](#running-behind-a-reverse-proxy-tls) for `location /<WSPATH>`, plus:

- `proxy_set_header X-Forwarded-Proto https;` and `proxy_set_header X-Forwarded-For $remote_addr;` — with `TRUST_PROXY=1` these drive the `__Host-`/`Secure` admin cookie and the client IPs in stats.
- Extra `location` blocks for `/admin-stats` and your `INVITE_PATH` prefix (default `/i/`) if you use those features — path-scoping to `/<WSPATH>` alone hides them, which is otherwise a feature.

Setting `VPS_HOST` in `npm run creds` also makes `npm run configs` render UDP-capable client configs for this host (`local/conf-vps.json`, `local/conf-android-vps.json`) — like the Fly ones, unlike the Worker/Deno ones.

---

## Admin Dashboard

A live stats page is available at:

```
http://your-server:port/admin-stats?token=<ADMIN_TOKEN>
```

It shows active connections, stream counts, protocol breakdown (TCP/UDP/Mux), total traffic, per-user totals, and connection history. It updates live over Server-Sent Events, about once a second — no page reload, so scroll position survives.

A nav at the top links to the provisioning page and to sign-out, so neither is a URL you have to remember. The provisioning entry appears only when `PROVISION_SECRET` is set, because that route otherwise serves the decoy.

The token is needed only once: it is exchanged for an `HttpOnly; Secure; SameSite=Strict` session cookie and the browser is redirected to a clean URL, so the credential stops appearing in history, bookmarks and `Referer`. `?logout=1` clears the session.

> [!TIP]
> **The token must be URL-encoded.** A token containing `+`, `/` or `=` — anything base64 — will not match if pasted raw, because `+` decodes to a space in a query string. A wrong token is served the decoy page rather than an error, so this looks like the server being down. `npm run creds` generates hex tokens and rejects unsafe ones; `npm run creds:push` prints the finished URL.

> [!WARNING]
> **This page prints your `WSPATH` and traffic stats.** With `ADMIN_TOKEN` unset it is hidden behind the decoy page; set `ADMIN_TOKEN` (and, on a VPS, also scope your reverse proxy to `/<WSPATH>`) before relying on it.

---

## Provisioning other people's devices

`/admin-stats/provision` mints a short-lived invite link for one configured user. They open it on their phone, scan or tap, and connect. **Fly/VPS only** — the Workers build has no admin page and stays single-user.

Each person gets their **own UUID**, derived rather than stored:

```
uuid(label) = HMAC-SHA256(PROVISION_SECRET, "vless-uuid-v1\n" + label)[0..16]
```

Nothing is written to disk, which matters because Fly machines have no volume — a users file would work in testing and vanish on the next deploy. The whole registry is reproducible from two secrets.

```bash
fly secrets set PROVISION_SECRET="$(openssl rand -hex 32)" USERS=alice,bob
fly secrets set PUBLIC_HOST=edge.example.com
```

Then open `/admin-stats/provision`, pick a user, and send them the link. It expires in 15 minutes.

**What the invitee gets.** The landing page carries no credential — chat apps fetch pasted URLs to build previews, and burning the invite there would kill it before the human taps. Tapping through reveals a `vless://` link (one tap into v2rayNG, Streisand, Hiddify or NekoBox), a QR of it, and a **full JSON config download**. The download exists because a share link structurally cannot carry a certificate: on a [TLS-intercepting network](#networks-that-intercept-tls) only the JSON works.

That config tunnels UDP, so games and voice chat — Roblox, Discord — work. QUIC (UDP/443) is the one exception: it is blocked by default, so browsers stay on TCP/TLS.

> [!NOTE]
> **Blocking QUIC is a default, not a verdict.** It does not avoid nesting — the browser then runs TCP inside a TCP tunnel, which is reliable-over-reliable either way. Tunnelling QUIC costs per-datagram framing through xudp/mux, a second layer of crypto, and head-of-line blocking when flows share a mux stream; against that, QUIC's loss recovery is better than TCP's, and a blackholed attempt makes the browser wait out a timeout instead of failing fast. Which wins depends on your path, so it is worth measuring rather than assuming.
>
> Tick **Tunnel QUIC as well** on the provisioning page to mint an invite with the other policy. The downloads are named `vless-<label>.json` and `vless-<label>-udp.json`, so the two are easy to keep apart while comparing.

**Revoking.** Drop the label from `USERS` and redeploy. Their credential stops authenticating immediately, including any live tunnel, and nobody else is affected.

> [!IMPORTANT]
> **Rotating `PROVISION_SECRET` invalidates every derived UUID at once**, and the failure looks like the server being down rather than a stale credential — a mismatched UUID gets the decoy page and a hangup. Rotate in two deploys: first set `PROVISION_SECRET_PREVIOUS` to the old value alongside the new `PROVISION_SECRET`, reissue everyone, then remove it.

> [!WARNING]
> **Provisioning happens over the network you are trying to circumvent.** The invitee downloads their credential through the same middlebox the config exists to work around, so an intercepting network sees it in plaintext at that moment. This inverts the usual intuition that the pinned CA is protective — it makes the tunnel work, it does not hide the handover. Provision over mobile data where it matters.

Two more things worth knowing. `fly secrets set` restarts the machine, so adding or removing a user briefly drops every tunnel and resets the stats counters — batch your changes. And invites are **not** reliably single-use: redemption is remembered in memory only, so a restart makes an unexpired link usable again. The 15-minute expiry is the real boundary.

---

## Cloudflare Workers

The Workers build runs the same VLESS protocol on Cloudflare's edge, with no server to maintain and TLS terminated for you. It is not a drop-in replacement — Workers cannot open UDP sockets, so parts of the feature set genuinely cannot exist there.

### Deploy

```bash
npx wrangler secret put UUID     # required — the Worker proxies nothing without it
npx wrangler deploy
```

There is no built-in fallback UUID. Until the secret is set the Worker serves the decoy page to every request and refuses to proxy, which means a deployment that happens before its secret is configured is inert rather than an open relay. For local runs, put `UUID=...` in `.dev.vars`, which is gitignored.

The Worker's `name` in `wrangler.toml` becomes its public hostname, so pick something unremarkable — it is visible to anyone who sees the URL. If you deploy from a connected Git repository, the project name in the Cloudflare dashboard must match that `name`, or the pipeline and the running Worker end up pointing at different things.

Then, optionally:

```bash
npx wrangler dev --remote        # local dev (--remote is required: outbound TCP
                                 # does not work in the offline simulator)
npx wrangler tail                # live logs
```

`DOH_URL` is an ordinary `[vars]` entry in `wrangler.toml`. `UUID`, `WSPATH`, and `PROXYIP` should all be secrets: the first is the authentication credential, and the other two would otherwise be published in the repository, which defeats the point of a non-obvious path and advertises your relay host.

```bash
npx wrangler secret put UUID       # required
npx wrangler secret put WSPATH     # optional, e.g. a random 16-hex string
npx wrangler secret put PROXYIP    # optional, e.g. 203.0.113.5:8443
```

Secrets survive redeployment, whereas plain-text vars are overwritten from `wrangler.toml` on every `wrangler deploy` — so a value set only in the dashboard as an unencrypted variable disappears the next time you push.

`WSPATH` is matched as a substring of the request path, so a leading slash is optional and query suffixes like `?ed=2048` still match. Unset, it defaults to `/`, which matches every upgrade; that is safe, since `UUID` is what actually authenticates, but a random path means scanners never reach the VLESS handler and only ever see the cover page.

### Feature Parity

| | Node (`appws.js`) | Workers | Deno Deploy |
|---|---|---|---|
| TCP proxying | ✅ | ✅ | ✅ |
| DNS over UDP (port 53) | ✅ native | ✅ via DNS-over-HTTPS | ✅ via DNS-over-HTTPS |
| UDP to any other port | ✅ | ❌ no UDP on Workers | ❌ no UDP on Deno Deploy |
| Mux.Cool (TCP substreams) | ✅ | ✅ | ✅ |
| Multi-user / device provisioning | ✅ | ❌ single-user only | ❌ single-user only |
| xUDP / Mux UDP substreams | ✅ | ⚠️ port 53 only | ⚠️ port 53 only |
| TLS | self-signed or reverse proxy | ✅ terminated at the edge | ✅ terminated at the edge |
| Admin dashboard | ✅ `/admin-stats` | ❌ use the Cloudflare dashboard | ❌ use the Deno Deploy dashboard |
| Destinations behind Cloudflare | ✅ | ⚠️ requires `PROXYIP` | ✅ direct dial (relay optional) |

> [!IMPORTANT]
> **Set `PROXYIP`.** A Worker cannot open a TCP connection back into Cloudflare's own edge, and a large share of the web sits behind Cloudflare. Without a relay host to retry through, those destinations simply fail to load. `PROXYIP` accepts `host` or `host:port`; when a direct dial returns nothing, the connection is retried through it.

> [!NOTE]
> QUIC/HTTP3 will not tunnel, since it is UDP — browsers fall back to TCP automatically. UDP-based games and voice chat will not work at all. Configure your client to route only `udp:53` through the proxy, or disable UDP.

### Setting Up the Relay Host (`PROXYIP`)

The retry dials `proxyHost:originalPort` and replays the client's first bytes, so the relay has to work out the destination itself. The practical way is to read the SNI from the TLS ClientHello and forward there — an **SNI forwarder**. Two consequences follow: it rescues TLS traffic on 443 only (plain HTTP has no SNI), and the relay needs **no certificate and no hostname of its own**, since it never terminates TLS. Don't issue a Let's Encrypt cert for it or set a `server_name`; the certificate the client validates belongs to the destination.

Any VPS works as long as its IP is not Cloudflare's. With nginx, this goes at the **top level** of `/etc/nginx/nginx.conf`, outside `http {}` — it cannot live in `conf.d/`, which is included *inside* `http {}`:

```nginx
stream {
    resolver 1.1.1.1 8.8.8.8 valid=300s ipv6=off;
    resolver_timeout 5s;

    server {
        listen 8443;
        ssl_preread on;
        proxy_pass $ssl_preread_server_name:443;

        proxy_connect_timeout 5s;
        proxy_timeout 3600s;
    }
}
```

The `resolver` line is mandatory: `$ssl_preread_server_name` is a runtime variable, so nginx must resolve it per connection. Confirm your build has the module with `nginx -V 2>&1 | grep -o with-stream_ssl_preread_module`.

Then open the port, remembering that cloud providers usually have a second firewall in front of the host — an AWS security group, an Oracle Cloud VCN security list — and the port stays closed until you add an ingress rule there too.

Verify from a machine *other* than the relay, so the test crosses both firewalls:

```bash
curl -sv --resolve www.cloudflare.com:8443:<relay-ip> \
     https://www.cloudflare.com:8443/ -o /dev/null 2>&1 | grep -E "subject:|HTTP/"
```

Getting `CN=www.cloudflare.com` back proves the forwarding works, since that certificate can only have come from the real host. A hang usually means the missing `resolver` line.

Getting **the relay's own certificate** back means something different and more serious: the port is being served by a `server {}` block inside `http {}` instead of by the `stream {}` block, so the relay is terminating TLS and impersonating every destination. On a host that already runs a web stack — YunoHost, Plesk, stock nginx with a default vhost — this is the usual outcome of reusing port 443, because that port already belongs to the existing site. Give the forwarder a port of its own.

The symptom seen from a client is distinctive and easy to misread: destinations the Worker can dial directly keep working normally, while everything that falls back through `PROXYIP` returns one wrong certificate belonging to the relay host. It looks like a client TLS problem and is not.

> [!CAUTION]
> Do not "fix" this by trusting or pinning that certificate. `tlsSettings` governs the outer client-to-Worker connection; the certificate you are seeing belongs to the inner end-to-end session, which the tunnel is supposed to carry untouched and which Xray never parses. There is no setting that reaches it, and accepting it would mean authorising a man-in-the-middle on every site reached through the relay. Fix the relay so it forwards without terminating.

> [!WARNING]
> As written this is an **open relay** — anyone who finds the port can bounce TLS through it, and it will be scanned. Since the only legitimate client is your Worker, restrict the source at the cloud firewall to Cloudflare's published IP ranges once you have confirmed it works end to end.

Finally, if the relay's hostname is on Cloudflare DNS, it must be **DNS-only** (grey cloud). A proxied record resolves to Cloudflare IPs and the Worker hits the exact block it was trying to escape.

### Client Configuration on Workers

Same as above, with these differences:

- **Address:** `<worker>.<subdomain>.workers.dev`, or a custom domain — recommended, as `workers.dev` is blocked in several regions.
- **Port:** `443`, **TLS:** on, with certificate verification left alone — the edge presents a publicly trusted certificate, so there is nothing to work around. `allowInsecure` no longer exists at all; see [Networks that intercept TLS](#networks-that-intercept-tls).
- **WS Path:** `/<WSPATH>?ed=2048` — the `ed=2048` suffix enables early data, which carries the first payload in the WebSocket handshake and saves a full round trip per connection.
- **Mux:** depends on your plan. `mux.concurrency: 8` reuses one WebSocket across many connections instead of paying a TLS handshake and WebSocket upgrade per connection. Measured against `-1` on the same hosts, six parallel connections dropped from 0.9–1.9s to 0.4–0.5s, and six sequential ones from ~4.9s to ~3.5s, with bulk throughput unaffected. **Enable it on Workers Paid.** On the Free plan leave it at `-1` — see [CPU time is the binding limit](#cpu-time-is-the-binding-limit-on-the-free-plan).

### Linux Transparent Proxy (TPROXY)

[`templates/linux-tproxy.json`](templates/linux-tproxy.json) is a complete Xray-core client config for a system-wide transparent proxy, and [`templates/android-socks.json`](templates/android-socks.json) is its counterpart for a phone — a local SOCKS inbound instead of TPROXY, plus the extras a filtered mobile network needs.

Both are templates: every secret in them is a `${...}` placeholder, and the three host fields deliberately share one token, because `serverName`, `wsSettings.host` and the outbound address must all be identical. You do not copy or edit them. Set your values once, then render:

```bash
npm run creds               # UUID, WSPATH, FLY_HOST, WORKER_HOST — press g to generate
npm run configs             # writes the four local/*.json
xray run -c local/conf-android.json
```

Two templates produce up to **six** configs, because the outputs vary along two independent axes — platform (TPROXY vs SOCKS) and target host:

| | Worker (no UDP) | Fly (UDP tunnelled) | Deno Deploy (no UDP) |
|---|---|---|---|
| **Linux TPROXY** | `local/conf.json` | `local/conf-udp.json` | `local/conf-deno.json` |
| **Android SOCKS** | `local/conf-android.json` | `local/conf-android-udp.json` | `local/conf-android-deno.json` |

The `-udp` variants target the Fly build, which carries UDP; the rest target the serverless builds, which do not. The two `-deno` configs render only when `DENO_HOST` is set in the store (otherwise they are skipped with a notice), so adding a Deno target does not disturb the existing four. See [CREDENTIALS.md](CREDENTIALS.md) for generating and rotating the values.

> [!IMPORTANT]
> `local/*.json` are **generated**. Editing one works until the next `npm run configs` silently discards it — put durable changes in `templates/` instead, and run `npm run configs:check` (exit 2 on drift) if you are unsure whether a file is still in sync.

Credentials never reach a commit because they never leave `local/credentials.json` (mode 0600, gitignored). The renderer refuses to write a config with an unreplaced placeholder, and `npm test` greps every committable file for a value from the store, so the old hand-editing failure mode is gone twice over.

Two details in it are deliberate and worth understanding before changing them.

**DNS goes over TCP.** `dns.servers` is `tcp://1.1.1.1`, so lookups become ordinary TCP connections to `1.1.1.1:53` through the tunnel and use the Worker's plain relay. UDP DNS would work too, via the DoH path, but TCP keeps the whole thing on one well-tested code path.

**UDP other than DNS is blackholed locally.** Workers has no UDP, so a `network: udp` routing rule sends the rest to a `blackhole` outbound and applications fail immediately instead of waiting on the Worker to refuse. For the same reason `mux.xudpProxyUDP443` is `reject` rather than `allow`, which makes browsers fall back to TCP for HTTP/3 straight away.

**`mux.concurrency` is `8` in the templates.** That is correct for the Fly build and for Workers **Paid**. On the Workers **Free** plan set it to `-1` in `templates/*.json` and re-render — `-1` disables TCP multiplexing while leaving XUDP intact, and it is the only safe setting against a 10 ms CPU budget.

Multiplexing is a real latency win but it is not free. Measured over the same workload, mux used roughly **twice the total CPU** of the plain relay (767 ms and 791 ms across two runs, against 399 ms) and — worse for the Free plan — concentrated all of it into **one** invocation rather than spreading it over 54, since a single WebSocket carries every connection. Against a 10 ms per-invocation budget that is fatal. Against 30 s on Paid it is irrelevant, and mux also *reduces* request count, because one upgrade serves up to eight connections.

So: `8` on Fly or Workers Paid, `-1` on Workers Free.

> [!NOTE]
> Until recently `-1` was the only setting that worked correctly, because the mux path had no `PROXYIP` retry: multiplexed substreams could not reach Cloudflare-hosted origins at all, so enabling mux silently broke a large share of the web while direct-dial destinations kept working. `src/worker/mux.mjs` now performs the same per-substream retry that `src/worker/relay.mjs` does. The retry is per substream rather than per connection, since one mux session carries many destinations at once.
>
> Note that several *simultaneous* large downloads can still fail with `unexpected eof`. That behaviour is identical with mux on and off, so it is a property of the tunnel rather than of multiplexing.

The `listen`/`port`/`sockopt.mark` values are specific to your nftables or iptables TPROXY rules and will need adjusting to match them.

> [!IMPORTANT]
> **`serverName` must equal `wsSettings.host`.** SNI fronting does not work on Cloudflare, including when the SNI is another Cloudflare domain. The edge terminates TLS by SNI, then compares the `Host` header against it and rejects mismatches:
>
> ```
> SNI=www.cloudflare.com  Host=www.cloudflare.com          -> 200 OK
> SNI=www.cloudflare.com  Host=developers.cloudflare.com   -> 403 Forbidden
> SNI=www.cloudflare.com  Host=<anything>.workers.dev      -> 403 Forbidden
> ```
>
> Carrying an SNI-fronting arrangement over from a self-hosted server therefore fails, with no WebSocket upgrade. If SNI-based blocking is the problem you are solving, a custom domain on Cloudflare is the fix: it gives you an unblocked hostname that legitimately matches both SNI and `Host`.
>
> Note that verifying this yourself requires `curl --http1.1`. Over HTTP/2 curl derives `:authority` from the URL and silently discards a manually set `Host` header, which makes every combination look like it succeeds.

If `workers.dev` resolves to slow edge IPs from your network, you can dial a specific Cloudflare address instead — set `vnext[0].address` to that IP while leaving `serverName` and `wsSettings.host` as your hostname. Cloudflare serves any customer domain from any of its edge IPs, so this stays within the matching rule above and is not fronting.

Do not carry a `pinnedPeerCertSha256` over from a self-hosted setup. It pins one specific certificate, and Cloudflare presents its own and rotates it, so the handshake fails within weeks at best.

### Importing on Android (QR)

`tools/qr.mjs` turns `local/conf-android.json` into a phone-scannable QR so you don't retype the config after a host change. Run `npm install` once, then:

```bash
npm run qr          # or: node tools/qr.mjs link
```

builds a `vless://` share link, prints it, renders a QR in the terminal, and writes `local/qr-link.png`. Scan it in any Xray client (v2rayNG, NekoBox, sing-box). This is the easy path **on ordinary networks** — a share link cannot carry a pinned CA, so it omits the `certificates` block (and mux).

```bash
npm run qr:serve    # or: node tools/qr.mjs serve
```

is for a [TLS-intercepting network](#networks-that-intercept-tls), where the profile must embed the CA. It serves the whole `conf-android.json` over your LAN at a random one-off path and QRs the URL; scan it from the phone on the same Wi-Fi, download, and import as a **Custom config**. The credentials never leave the LAN — Ctrl-C stops the server when you're done. Both accept an alternate config path as an argument (default `local/conf-android.json`); `qr-link.png` encodes your UUID, so it stays in gitignored `local/`.

### Networks that intercept TLS

Some networks — corporate, school, and national filters — terminate every TLS connection on a middlebox and re-sign it with their own root CA. Two consequences shape the whole config:

- **HTTP/2 stops working**, because interception forces traffic back to HTTP/1.1. WebSocket is what survives, which is why this transport is the right choice here even though Xray now prints `WebSocket transport … is deprecated, migrate to XHTTP H2 & H3` on startup. **Ignore that warning on such a network.** H2 is precisely what the middlebox breaks, and H3 is QUIC over UDP, which these networks generally block outside ports 53 and 123. Do not "migrate" and expect it to keep working.
- **The certificate your client sees is not Cloudflare's.** You have to trust the interception CA, or the handshake fails.

Add the CA to `tlsSettings.certificates` rather than installing it system-wide. Both templates carry a `${CA_PEM_LINES}` marker, and `npm run configs` splices the PEM in from `src/node/interceptca.js`, so there is nothing to paste:

```json
"tlsSettings": {
  "serverName": "${HOST}",
  "certificates": [
    { "usage": "verify", "certificate": ["${CA_PEM_LINES}"] }
  ]
}
```

Choose the CA in `npm run creds` → `INTERCEPT_CA_FILE`, which offers three named states: **bundled** (the root from `src/node/interceptca.js`), **none** (omit the `certificates` block entirely), or **file** (your own **PEM**, not DER — convert a `.cer` with `openssl x509 -inform der -in x.cer -out ca.pem`). `npm run configs` prints which one is in effect.

This **adds** to the system trust store rather than replacing it — `disableSystemRoot` defaults to `false` — so ordinary public certificates still validate. On Android this is not merely tidier but required: Go reads only `/system/etc/security/cacerts`, so a CA you install through Settings is invisible to Xray.

Note that forgetting to replace the placeholder is not caught by `xray run -test`. Xray ignores PEM it cannot parse rather than rejecting the config — which is why `npm run configs` parses it with `node:crypto`'s `X509Certificate` and refuses to write anything if it fails, so the certificate is simply never added to the pool. That fails closed rather than open — verification still runs against the public roots — but it surfaces as an `x509` error when you connect, not when you validate. If a config that tests clean fails to handshake on an intercepting network, check the certificate block first.

Two caveats. On **Windows** a CA supplied this way is silently ignored unless you also set `disableSystemRoot: true`, which then drops the public roots; import it into the Windows certificate store instead. And `alpn` should be **left unset** — Xray's WebSocket dialer already pins `http/1.1`, so setting it explicitly does nothing and setting `["h2","http/1.1"]` will break the upgrade.

> [!IMPORTANT]
> **`allowInsecure` was removed in Xray v26.2.6** and stopped working entirely on 2026-06-01. A config still carrying it does not warn — it refuses to start:
> `The feature "allowInsecure" has been removed and migrated to "pinnedPeerCertSha256".`
>
> Trusting the interception CA as above is the correct replacement. If the middlebox's re-signed certificate turns out to carry no matching SAN, use `verifyPeerCertByName`, which takes a **string, not an array** (the published documentation has this wrong):
>
> ```json
> "verifyPeerCertByName": "your-host.example.com"
> ```
>
> Reach for `pinnedPeerCertSha256` only as a last resort — pinning against Cloudflare breaks on every certificate rotation, roughly quarterly.

Finally, if the network is IPv4-only — common behind such filters — an AAAA answer will strand the client, since `workers.dev` and Cloudflare custom domains publish both A and AAAA. Force the address family on the outbound:

```json
"sockopt": { "domainStrategy": "UseIPv4" }
```

### Other Workers Limits

- **Free plan allows 50 subrequests per request**, against 10,000 on Paid. Only DNS consumes these, and answers are cached at the edge to stay well under it.
- **WebSocket messages are capped at 1 MiB** in both directions.
- **Every `wrangler deploy` drops all live connections.**

### CPU time is the binding limit on the Free plan

It is tempting to assume a relay is I/O-bound and therefore cheap. Waiting on the network genuinely does not count against CPU time — but *moving bytes does*, and the Free plan allows only **10 ms of CPU per invocation** against **30 s** on Paid (raisable to 5 minutes).

Measured on a deployed Worker with `wrangler tail --format json`:

| Path | CPU per MB | What fits in 10 ms |
|---|---|---|
| Plain relay (`mux.concurrency: -1`) | ~12.6 ms/MB | ~800 KB |
| Mux (`mux.concurrency: 8`) | ~40 ms/MB | ~250 KB |

On the Free plan this is what a large transfer failing actually looks like: a download that stalls for a couple of minutes and returns nothing, `SSL_read: unexpected eof` when several transfers run at once, or connections that succeed intermittently for no visible reason. Those are CPU exhaustion, not network faults — confirm with `exceededCpu` outcomes in `wrangler tail` before hunting elsewhere.

There is no way to code around a 12–40× shortfall. **Workers Paid is the fix**, and since billing is on CPU rather than wall-clock duration, an idle long-lived tunnel costs essentially nothing; the $5/month includes 10M requests and 30M CPU-ms, which at these rates is several hundred GB of traffic.

---

## Deno Deploy

Deno Deploy runs the same VLESS protocol on Deno's edge, and like the Worker it is serverless with TLS terminated for you and **no UDP** — so the [feature parity](#feature-parity) and QUIC/UDP caveats above apply identically. It exists as a second serverless option: a different provider to fall back to, and one whose network can dial Cloudflare-fronted destinations directly, so `PROXYIP` is optional rather than close to mandatory.

The entire `src/worker/` codebase is reused unchanged. Only two files are Deno-specific:

- `src/deno/main.mjs` — the `Deno.serve` entry. It maps the Worker's `WebSocketPair` to `Deno.upgradeWebSocket`, builds the `env` object from `Deno.env`, and supplies two small shims the shared code expects: a `ctx.waitUntil` (Deno keeps the socket's promises alive on its own, so it only swallows rejections) and `caches.default` (defined once from `caches.open('doh')`, since Deno exposes the Web Cache API without the `.default` handle Cloudflare adds).
- `src/deno/sockets.mjs` — a stand-in for `cloudflare:sockets`, wrapping `Deno.connect` to present the same `{ opened, readable, writable, close }` surface. `deno.json`'s import map aliases the `cloudflare:sockets` specifier to it, which is why `relay.mjs`/`mux.mjs` need no edits.

### Deploy

```bash
# 1. Install the Deno CLI and the deployment tool
curl -fsSL https://deno.land/install.sh | sh
deno install -Arf jsr:@deno/deployctl

# 2. Run it locally to smoke-test (reads UUID/WSPATH/etc. from the environment)
UUID=<your-uuid> WSPATH=/<your-path> deno task start   # serves on http://localhost:8000

# 3. Deploy (set env vars in the Deno Deploy dashboard: UUID, WSPATH, PROXYIP, DOH_URL)
deno task deploy
```

`UUID` is the only credential and has **no default** — until it is set, every request gets the decoy page and nothing is proxied, exactly as on the Worker. Set `UUID`, `WSPATH`, and optionally `PROXYIP`/`DOH_URL` as environment variables in the project's settings (`DOH_URL` defaults to Cloudflare's resolver).

To set them in one step instead of typing each by hand, run **`npm run creds:env`** (or press `e` in `npm run creds`). It writes `local/deno.env` — a `KEY=value` file holding `UUID`, `WSPATH`, and `PROXYIP` (whichever are set) — which you upload, or paste, into the Deno Deploy dashboard's environment-variable import. The file is `0600` and lives in the gitignored `local/` dir; it prints only the path, never the secrets.

### Client Configuration

Set `DENO_HOST` in the credential store (`npm run creds`) to your Deno Deploy hostname, then `npm run configs`. Two extra configs appear — `local/conf-deno.json` (Linux TPROXY) and `local/conf-android-deno.json` (Android SOCKS) — built exactly like the Worker configs (no UDP, DNS over TCP through the relay). If `DENO_HOST` is unset, those two are skipped with a notice and the other configs render as before.

---

## Project Structure

All builds share the protocol code in `src/` and split the rest into small,
single-purpose modules. The Node build is `src/node/` (CommonJS); the Workers
build is `src/worker/` (ESM); the Deno Deploy build is `src/deno/` (ESM) and
reuses `src/worker/` wholesale, adding only a runtime entry and a
`cloudflare:sockets` shim. `src/vless.js` and `src/decoy.js` are shared by all.

```
appws.js              # Node entry point — requires src/node/server.js and listens
CREDENTIALS.md        # generating and rotating credential values
templates/            # client config templates — placeholders only
  linux-tproxy.json   #   Linux system-wide TPROXY
  android-socks.json  #   Android / local SOCKS
local/                # credentials.json plus the configs rendered from it (gitignored)
tools/
  credentials.mjs     #   interactive credential manager (npm run creds)
  credstore.mjs       #   the store: schema, validation, atomic read/write
  render-configs.mjs  #   renders local/*.json from templates/ + the store
  qr.mjs              #   share link / QR pipeline
src/vless.js          # VLESS parser + byte queue, shared by both builds
src/decoy.js          # decoy cover page, shared by both builds
src/node/             # Node.js server build
  server.js           #   createServer/startServer, TLS-vs-plaintext dispatch
  session.js          #   per-connection state machine, backpressure contract
  http.js             #   HTTP/1.1 head parsing, response writers, accept key
  wsframe.js          #   WebSocket frame encode/decode
  relay.js            #   VLESS CMD 1: TCP tunnel
  udp.js              #   VLESS CMD 2: length-prefixed UDP
  mux.js              #   VLESS CMD 3: Mux.Cool / xUDP substreams
  dnscache.js         #   DNS cache + in-flight request coalescing
  stats.js            #   connection and traffic counters
  pages.js            #   admin dashboard rendering
  users.js            #   HMAC-derived per-user credentials, registry lookup
  tokens.js           #   signed invites and admin sessions, burn store
  clientconf.js       #   vless:// links and Xray config generation
  interceptca.js      #   baked interception CA for generated configs
  provision-pages.js  #   invite minting and redemption pages
  ratelimit.js        #   token-bucket limiter for admin/invite routes
  config.js           #   env reading (the only module that touches process.env)
  tlscert.js          #   bundled self-signed keypair, TLS detection
  log.js              #   timestamped logger
src/worker/           # Cloudflare Workers build
  index.mjs           #   fetch entry: routing, handshake, header parse
  relay.mjs           #   TCP relay over cloudflare:sockets, PROXYIP retry
  dns.mjs             #   UDP port 53 via DNS-over-HTTPS
  mux.mjs             #   Mux.Cool substream multiplexing
  wsstream.mjs        #   WebSocket to ReadableStream adapter
  config.mjs          #   env reading, cached UUID bytes
  bytes.mjs           #   base64url and length-prefix helpers
  pages.mjs           #   decoy page (re-exports src/decoy.js)
src/deno/             # Deno Deploy build (reuses all of src/worker/)
  main.mjs            #   Deno.serve entry: upgrade, env, ctx/cache shims, pump
  sockets.mjs         #   cloudflare:sockets shim over Deno.connect
test/                 # node:test suite — `npm test`, zero dependencies
deno.json             # import map (cloudflare:sockets -> shim) + start/deploy tasks
wrangler.toml
README.md
```

### Tests

```bash
npm test
```

Uses Node's built-in test runner, so there is nothing to install. The suite
covers the WebSocket codec, HTTP head parsing, config, stats, the DNS cache,
the admin-token gate, credential derivation, invite signing, the provisioning
gate truth table, and end-to-end tunnels over all three VLESS commands (TCP,
legacy UDP, and Mux.Cool) against real echo servers.

`test/image.test.js` walks the require graph from `appws.js` and fails if
anything the server loads falls outside the Dockerfile's COPY list or pulls in
an npm dependency — the class of mistake that works locally and crashes the
container on boot.

`src/node/server.js` is importable without side effects — `createServer()`
builds a server without binding a port, printing a banner, or starting a timer
that would hold the event loop open. `appws.js` is the only thing that listens.

---

## Credits

- Original implementation: [eooce/node-ws](https://github.com/eooce/node-ws) — licensed under [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)
- xUDP and Mux.Cool implementations assisted by Kimi K2.6

---

## License

This project is licensed under the **GNU General Public License v3.0**, same with original project's license.

See [LICENSE](https://github.com/cocaococao/better-nodejs-vless-ws/blob/main/LICENSE) for details.
