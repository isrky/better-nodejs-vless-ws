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

Two builds ship from this repo, sharing the VLESS protocol parser in `src/vless.js`:

- **Node.js** (`appws.js`) — the full-featured self-hosted server. Everything below applies to it unless noted.
- **Cloudflare Workers** (`src/worker/`) — a serverless build with no VPS to run. See [Cloudflare Workers](#cloudflare-workers) for its capabilities and limits.

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
| `UUID` | `7bd180e8-...` | VLESS authentication UUID |
| `WSPATH` | First 8 chars of UUID (can be changed through variables) | WebSocket path prefix |
| `PORT` / `SERVER_PORT` | `3000` | Listening port |

**Example:**

```bash
UUID=your-uuid-here WSPATH=mypath PORT=8080 node appws.js
```

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

## Admin Dashboard

A live stats page is available at:

```
http://your-server:port/admin-stats
```

It shows active connections, stream counts, protocol breakdown (TCP/UDP/Mux), total traffic, and connection history. Auto-refreshes every 5 seconds.

> [!WARNING]
> **Do not expose this endpoint publicly in production. Protect it with your reverse proxy.**

---

## Cloudflare Workers

The Workers build runs the same VLESS protocol on Cloudflare's edge, with no server to maintain and TLS terminated for you. It is not a drop-in replacement — Workers cannot open UDP sockets, so parts of the feature set genuinely cannot exist there.

### Deploy

```bash
npx wrangler secret put UUID     # your VLESS UUID — do not leave the default
npx wrangler deploy
```

Then, optionally:

```bash
npx wrangler dev --remote        # local dev (--remote is required: outbound TCP
                                 # does not work in the offline simulator)
npx wrangler tail                # live logs
```

`WSPATH`, `PROXYIP`, and `DOH_URL` are set in `wrangler.toml` under `[vars]`. `UUID` is the only authentication credential, so it belongs in a secret rather than the committed config.

### Feature Parity

| | Node (`appws.js`) | Workers |
|---|---|---|
| TCP proxying | ✅ | ✅ |
| DNS over UDP (port 53) | ✅ native | ✅ via DNS-over-HTTPS |
| UDP to any other port | ✅ | ❌ no UDP on Workers |
| Mux.Cool (TCP substreams) | ✅ | ✅ |
| xUDP / Mux UDP substreams | ✅ | ⚠️ port 53 only |
| TLS | self-signed or reverse proxy | ✅ terminated at the edge |
| Admin dashboard | ✅ `/admin-stats` | ❌ use the Cloudflare dashboard |
| Destinations behind Cloudflare | ✅ | ⚠️ requires `PROXYIP` |

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
        listen 9443;
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
curl -sv --resolve www.cloudflare.com:9443:<relay-ip> \
     https://www.cloudflare.com:9443/ -o /dev/null 2>&1 | grep -E "subject:|HTTP/"
```

Getting `CN=www.cloudflare.com` back proves the forwarding works, since that certificate can only have come from the real host. A hang or certificate mismatch usually means the missing `resolver` line.

> [!WARNING]
> As written this is an **open relay** — anyone who finds the port can bounce TLS through it, and it will be scanned. Since the only legitimate client is your Worker, restrict the source at the cloud firewall to Cloudflare's published IP ranges once you have confirmed it works end to end.

Finally, if the relay's hostname is on Cloudflare DNS, it must be **DNS-only** (grey cloud). A proxied record resolves to Cloudflare IPs and the Worker hits the exact block it was trying to escape.

### Client Configuration on Workers

Same as above, with these differences:

- **Address:** `<worker>.<subdomain>.workers.dev`, or a custom domain — recommended, as `workers.dev` is blocked in several regions.
- **Port:** `443`, **TLS:** on, **allowInsecure:** off (there is no self-signed certificate any more).
- **WS Path:** `/<WSPATH>?ed=2048` — the `ed=2048` suffix enables early data, which carries the first payload in the WebSocket handshake and saves a full round trip per connection.

### Other Workers Limits

- **Free plan allows 50 subrequests per request.** Only DNS consumes these, and answers are cached at the edge to stay well under it.
- **WebSocket messages are capped at 1 MiB** in both directions.
- **Every `wrangler deploy` drops all live connections.**
- CPU limits are not a concern: the relay is I/O-bound, and I/O wait does not count against them.

---

## Project Structure

```
appws.js              # Node.js server (single file)
src/vless.js          # VLESS parser + byte queue, shared by both builds
src/worker/           # Cloudflare Workers build
  index.mjs           #   fetch entry: routing, handshake, header parse
  relay.mjs           #   TCP relay over cloudflare:sockets, PROXYIP retry
  dns.mjs             #   UDP port 53 via DNS-over-HTTPS
  mux.mjs             #   Mux.Cool substream multiplexing
  wsstream.mjs        #   WebSocket to ReadableStream adapter
  config.mjs          #   env reading, cached UUID bytes
  bytes.mjs           #   base64url and length-prefix helpers
  pages.mjs           #   decoy page
wrangler.toml
README.md
```

---

## Credits

- Original implementation: [eooce/node-ws](https://github.com/eooce/node-ws) — licensed under [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)
- xUDP and Mux.Cool implementations assisted by Kimi K2.6

---

## License

This project is licensed under the **GNU General Public License v3.0**, same with original project's license.

See [LICENSE](https://github.com/cocaococao/better-nodejs-vless-ws/blob/main/LICENSE) for details.
