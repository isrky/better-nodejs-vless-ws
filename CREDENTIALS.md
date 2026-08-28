# Credentials

Every secret lives in one file: `local/credentials.json`, mode 0600, gitignored,
written only by `npm run creds`. Nothing secret is ever committed — `templates/`
holds placeholders, and the four `local/*.json` configs are **derived**, rendered
from the store by `npm run configs`.

That makes the store the only thing worth backing up. Delete a rendered config
and re-render it; lose the store and you are rotating. The tool keeps one
generation in `credentials.json.bak`, which is a safety net against its own
bugs — not a backup. Copy the store somewhere yourself.

## Generating values

Run `npm run creds`, switch to the field's tab (`←`/`→`, `h`/`l`, or `Tab`/`Shift+Tab`
— one tab per group, plus `config` for the per-deployment fields), move to a
field (`↑↓` or `j`/`k`), press `g` — the value
is generated and written through on that single keypress. Prefer that over
typing: a generated secret never exists outside the store and the redacted
display. On a fresh store, `S` runs the quick setup instead: it generates
every missing generatable field at once (UUID, WSPATH, and — after a `y` —
ADMIN_TOKEN and PROVISION_SECRET), then walks you through the required
hostnames. The walk switches tabs to follow the field it is editing.

For reference, `g` is equivalent to:

| Value | Command |
|---|---|
| `UUID` | `uuidgen \| tr 'A-Z' 'a-z'` |
| `WSPATH` | `printf '/%s\n' "$(openssl rand -hex 16)"` |
| `ADMIN_TOKEN` | `openssl rand -hex 32` |
| `PROVISION_SECRET` | `openssl rand -hex 32` |

`PROVISION_SECRET_PREVIOUS` is the one secret `g` will not generate — it may
only ever hold a value that was previously current.

### Managing provisioned users

On the `server` tab, Enter on `USERS` opens a list manager instead of the raw
space-separated field. Use `a` to add a label, Enter or `r` to rename the
selected label, and `d` to delete it; rename and delete both require a `y`
confirmation because the old derived UUID stops authenticating after the next
deployment. `D` (or `c` on the `USERS` dashboard row) confirms deleting the
whole list. Every completed action writes through immediately and remains
covered by the dashboard's one-step `u` undo.

Labels are folded to lowercase and must match `[a-z0-9_-]`, start with a letter
or digit, fit in 32 characters, and be unique. `owner` is reserved and the list
is capped at 64 users. The manager never displays a derived UUID. User changes
update the local store and encrypted payload; commit that payload and redeploy
before the addition or revocation takes effect.

Every generated secret is hex, so every one of them is URL-safe. That matters
for `ADMIN_TOKEN` specifically: it is consumed as `/admin-stats?token=…`, and a
base64 token's `+` decodes to a **space** in a query string, so the comparison
fails and the request is served the decoy — a 200 identical to `GET /`, which
reads as an outage rather than a bad token. The tool now rejects an
`ADMIN_TOKEN` containing anything a URL would mangle, so you cannot set one by
hand either.

`UUID` must be lowercase 8-4-4-4-12 — the renderer rejects anything else, and
rejects the default published in this repo. `WSPATH` keeps its leading slash;
it is matched server-side as a substring, so it is obscurity rather than
authentication. The UUID is the credential.

## Where each value goes

Everything lives in the store; this is where each value additionally has to be
pushed.

| Value | Renders into configs | Fly | Worker | `g` |
|---|---|---|---|---|
| `UUID` | yes | yes | yes | yes |
| `WSPATH` | yes | yes | yes | yes |
| `FLY_HOST`, `WORKER_HOST` | yes | no — Fly uses `PUBLIC_HOST` in `fly.toml` | no | no |
| `INTERCEPT_CA_FILE` | yes | no | no | no |
| `ADMIN_TOKEN` | no | yes | n/a — no admin panel | yes |
| `PROVISION_SECRET` | no | yes | n/a — single-user | yes |
| `PROVISION_SECRET_PREVIOUS` | no | yes | n/a | never |
| `USERS` | no | yes | n/a | no |
| `PROXYIP` | no | no | yes | no |

## Rotating `UUID` / `WSPATH` / `ADMIN_TOKEN`

> [!WARNING]
> Step 3 disconnects every device still holding the old credential — including
> the one you are typing on. **Do it from a network you do not reach through the
> tunnel**, or you can lose access to the Fly and Cloudflare dashboards midway.

1. Copy `local/credentials.json` somewhere safe.
2. `npm run creds` → highlight the field → `g`. Edits are written through
   immediately, so there is nothing to save and quitting is always safe.
3. `npm run configs` — validates before writing, so a malformed value stops here
   rather than becoming a config that `xray -test` accepts and the server rejects.
4. `npm run creds:push`, confirm at the prompt, then paste each value into the
   two dashboards it links. `UUID` and `WSPATH` are shared by both deployments,
   so both need them or half your configs break.
5. Re-import on every device — `npm run qr` or `npm run qr:serve`. Run
   `npm run configs` **first**: a QR built from a stale file encodes the old
   UUID and the phone fails with no useful error.
6. `npm run configs:check` — exit 0 means disk matches the store.

To roll back: `u` in the dashboard (or restore `credentials.json.bak`), then
`npm run configs` and re-push. The configs are derived, so there is nothing
else to restore.

### Emergency rotation: the `nuke` tab

The fifth, red `nuke` tab is the deliberate "assume these credentials leaked"
path. It offers two actions and requires typing `NUKE` (any case) before
either one writes anything:

- **soft nuke** regenerates `UUID` and `WSPATH`, plus `ADMIN_TOKEN` and
  `PROVISION_SECRET` when those optional features are already enabled. It keeps
  the existing encryption-group keys and re-encrypts the committed payload.
- **full nuke** makes the same credential changes, regenerates all three group
  keys, and re-encrypts `src/node/secrets.enc.json` under them. It is available
  only for the canonical store; a scratch `--store` cannot alter production
  keys or ciphertext.

Neither action enables an optional feature that was unset, and neither changes
hosts, CA choices, `USERS`, or `PROXYIP`. They differ in how the provisioning
secret transitions: on a **soft** nuke, when provisioning is enabled the old
`PROVISION_SECRET` becomes `PROVISION_SECRET_PREVIOUS` so already-issued users
keep working during the cutover; remove the previous value after reissuing them
if the response requires immediate invalidation. An orphaned previous secret is
cleared when there is no current provisioning secret to rotate. A **full** nuke
is a total reset — it deletes `PROVISION_SECRET_PREVIOUS` outright, so every
already-issued user is cut off and must be reissued after the rotation.

The full operation prepares every new value before writing and restores the
store, its prior backup, the keyring, and the ciphertext if any write fails.
After success the dashboard stays open on a redacted checklist: perform a full
nuke from a network outside the tunnel, set the new group keys on all four
platforms, commit and push the new ciphertext, redeploy as a coordinated
cutover, then regenerate and re-import every client config.

> [!NOTE]
> **Rotating `ADMIN_TOKEN` does not log out live admin sessions** whenever
> `PROVISION_SECRET` is set, because the session cookie is signed with a key
> derived from `PROVISION_SECRET`, not from the token (`src/node/config.js`).
> An existing `__Host-adm` cookie stays valid for the rest of its TTL — 12 hours
> by default. The comment in that file about rotation invalidating every session
> is true only in the fallback case where `PROVISION_SECRET` is unset.
>
> Rotating the token still closes off anyone who only has the *token*. To end
> existing browser sessions as well, rotate `PROVISION_SECRET` — which also
> invalidates every provisioned user, so read the section below first.

## `PROVISION_SECRET` is different

Every provisioned user's UUID is derived from it, so rotating it invalidates all
of them at once — and the failure looks like the server being down, since a
mismatched UUID gets the decoy page and a hangup.

Rotate across two deploys: set `PROVISION_SECRET_PREVIOUS` to the old value
alongside the new `PROVISION_SECRET` so both authenticate, reissue everyone's
invite, then drop the previous one. See README § Provisioning other people's
devices.

## The store

`local/credentials.json`, mode 0600, gitignored. **Never hand-edit it** — use
`npm run creds`, which validates every value before writing and writes
atomically. If you must repair it by hand, run `npm run creds:status`
afterwards to confirm it still parses.

It carries a `version` field. A file with a missing, non-integer, or
newer-than-supported version is a hard error rather than being treated as
empty — silently starting from scratch and re-prompting for everything is how
you lose a credential.

### The CA has three states, not a value

`INTERCEPT_CA_FILE` is the one field where "blank" would be ambiguous, so the
dashboard offers three named choices instead:

| choice | what the configs get |
|---|---|
| **bundled** | the MEB `fatihca` root from `src/node/interceptca.js` (the key is absent) |
| **none** | no `certificates` block at all (the key is an empty string) |
| **file** | your own **PEM** — not DER; convert a `.cer` with `openssl x509 -inform der -in x.cer -out ca.pem` |

The distinction matters because collapsing "bundled" into "none" produces
configs that work everywhere except the intercepting network the CA exists for,
and the failure looks like a network fault. `npm run configs` prints which of
the three is in effect on every run.

## Migrating from `local/.env`

The retired dotenv file is imported once:

```bash
node tools/credentials.mjs --import local/.env
node tools/credentials.mjs --import local/rotation-*/new.env   # if ADMIN_TOKEN lived there
npm run configs                                                # must print "unchanged"
```

The import never modifies the source, never overwrites a differing key without
`--force`, and carries over keys it does not manage rather than dropping them.
Once every key is covered, rename the old file rather than deleting it —
`mv local/.env local/.env.migrated-$(date +%F)`.

> [!WARNING]
> The `local/rotation-*/` scripts are superseded, and one of them is actively
> misleading:
>
> - `rollback.sh` does `cp old.env local/.env` — a file nothing reads any more,
>   so a rollback would appear to succeed and restore nothing, at the worst
>   possible moment. Either delete it or replace that line with
>   `node tools/credentials.mjs --import "$DIR/old.env" --force && npm run configs`.
> - `apply-remote.sh` is redundant and was already incomplete: it pushes only
>   `UUID`, `WSPATH` and `ADMIN_TOKEN` — missing `PROVISION_SECRET`, `USERS` and
>   `PROXYIP` — and passes them in `argv`, where `ps` can read them. Use
>   `npm run creds:push` instead, which covers every pushable key.

## Encrypted secrets & group keys

Pasting every secret into four dashboards on every change is the drift-prone
part. The alternative: keep the secrets **encrypted in git** and give each
deployment only the keys to decrypt its own.

`src/node/secrets.enc.json` is committed. Its values are AES-256-GCM ciphertext;
its structure (group and field names) is cleartext, so it is safe in a public
repo. Secrets are split into three groups, each with its own key:

| group | fields | who holds the key |
|---|---|---|
| `common` | `UUID`, `WSPATH` | all four deployments |
| `server` | `ADMIN_TOKEN`, `PROVISION_SECRET`, `PROVISION_SECRET_PREVIOUS`, `USERS` | Fly, VPS |
| `edge` | `PROXYIP` | Worker, Deno |

The three keys live locally in `local/secrets.keys.json` (gitignored, 0600) —
the **keyring**. Each runtime decrypts on boot, reading its two keys from env
vars (`SECRETS_KEY_COMMON` plus `SECRETS_KEY_SERVER` or `SECRETS_KEY_EDGE`) and
the committed ciphertext bundled into its build. A deployment therefore holds
only keys, never the secret values.

The dashboard mirrors this split: one tab per group (`common`, `server`,
`edge`) plus a `config` tab for the per-deployment fields, so every field
lives in exactly one tab and the tab bar counts each tab's problems. An `envs`
tab lists the four deployment targets; `enter`/`y` copies that target's
group-key block (`SECRETS_KEY_*=…`) to the clipboard — over SSH via the OSC 52
terminal escape so it lands on your *local* clipboard, or through a local
`wl-copy`/`xclip`/`pbcopy` when a display is present. The key values never
render on screen (they are read from the keyring only at copy time), and a
target whose keyring groups are missing refuses to copy.

Opening the tab also checks each written file (`local/*.env`) against the
current keyring and marks it **up to date**, **stale**, or **not written** —
files go stale after a key rotation, since they still hold the old keys. When
any is stale, the help bar offers `u`, which rewrites all four 0600 files and
re-checks. The comparison reads the keyring off-screen, so no value is shown.

**Set up once:**

```bash
node tools/credentials.mjs --init-keys   # generate the keyring, encrypt the store
npm run creds:keys                        # reveal the two keys each platform needs
```

Set each platform's two keys once — `fly secrets set SECRETS_KEY_COMMON=… SECRETS_KEY_SERVER=…`,
`wrangler secret put SECRETS_KEY_COMMON` / `SECRETS_KEY_EDGE`, the Deno dashboard,
the VPS `.env`. They do **not** change when you rotate a secret.

`e` in the dashboard exports one paste-ready env file per deployment target —
`local/fly.env` and `local/docker.env` (common + server), `local/worker.env`
and `local/deno.env` (common + edge). `npm run creds:env` and
`npm run creds:docker` still write just the Deno and Docker files from the CLI,
and `npm run creds:keys` prints the same four blocks to the terminal. These
0600 files contain only group keys; deployment config such as `PUBLIC_HOST`,
`FRONT_SNI`, and `DOH_URL` must be added separately. Export refuses to write
without the complete keyring.

**Change a secret afterwards:** edit it in `npm run creds` (the dashboard
re-encrypts `secrets.enc.json` on every save), commit and push the encrypted
file, then `git pull` + redeploy each target. No re-pasting. The `push` tab
does the commit and push for you: it shows whether `src/node/secrets.enc.json`
is uncommitted or unpushed and, on `enter` then `y`, commits just that file
(message "Update encrypted secrets") and pushes — the git state (branch,
ahead/behind) is read on entry, and the file's contents never appear on screen.
`npm run creds:encrypt` re-encrypts on demand; `npm run creds:decrypt` rebuilds
`local/credentials.json` from the committed file on a fresh clone (needs the keyring).

**Rotating a group key** (not a secret — the key itself): `--init-keys --force`
regenerates the whole keyring and re-encrypts, then re-set the keys on every
platform. Because it re-keys all three groups, do it deliberately.

> [!WARNING]
> **Back up `local/secrets.keys.json`.** It is now as critical as the store:
> lose the keyring *and* the plaintext store and the committed ciphertext is
> unrecoverable — you are rotating everything.
>
> A missing or wrong key never crashes a deployment — it leaves those fields
> unset. On the **Worker and Deno** builds that means the decoy (they have no
> `UUID` default). On the **Node/Fly/VPS** build, an unset `UUID` falls back to
> the *published* `DEFAULT_UUID`, i.e. an open proxy on a well-known credential
> — so double-check `SECRETS_KEY_COMMON` on those targets, and set `UUID`
> explicitly if you want a hard fail instead of that fallback.

Per-deployment config that *differs* per target — `PUBLIC_HOST`, `FRONT_SNI`,
the `*_HOST` fields, ports, `DOH_URL` — is deliberately **not** in the encrypted
file (it cannot share one group key). It stays in `fly.toml` / `compose.yaml` /
the dashboard, reviewable in git.

## Pushing to the dashboards

The manual per-secret paste below still works, and is what you use if you have
not adopted the encrypted-file flow above (or for a one-off).

`npm run creds:push` shows what it is about to reveal, asks for a `y`, then
prints every pushable value grouped by where it is pasted — with the Fly app and
Worker project names read out of `fly.toml` and `wrangler.toml`, and a link
straight to the Fly secrets page.

When `ADMIN_TOKEN` and `FLY_HOST` are both set it also prints the dashboard URL
with the token already encoded, so opening the admin panel is one click rather
than an assembly step.

Two things it tells you that are easy to get wrong by hand:

- **On Cloudflare, add each one as a Secret, not a plaintext Variable.** A
  plaintext variable is overwritten from `wrangler.toml` on the next
  `wrangler deploy`; a secret survives. This is the failure mode worth knowing
  about, because it appears to work — the tunnel comes up, and then breaks days
  later when someone redeploys for an unrelated reason.
- **Setting a Fly secret restarts the machine**, which drops every live tunnel
  and resets the stats counters. Set them in one batch rather than one at a time.

Off a terminal it refuses and exits 1 rather than printing anything, so
`npm run creds:push > notes.txt` will not put credentials in a file. `--yes`
overrides that when you mean it.

## What the terminal sees

The interactive dashboard is an Ink app and uses raw mode; it restores the
terminal on every exit path, including errors and Ctrl-C, and a terminal that
cannot enter raw mode gets the status report instead of a crash. Every
non-interactive invocation — the flags, and anything without a TTY — never
loads Ink at all and prints plain lines, so pipes and scripts are unaffected.

- A **typed** secret is masked as you type (`•` per character plus a length),
  so unlike the old readline menu it is never echoed and never reaches
  scrollback. Still prefer `g` when *setting* a value — a generated secret has
  full entropy and never passes through a keyboard or clipboard at all.
- `npm run creds:push` (and `p` → `y` in the dashboard) prints values **by
  design**: you cannot paste into a web form what you cannot see. The dashboard
  prints them only *after* the UI has torn down, so they land in ordinary
  scrollback — and they stay there, which is the cost of a dashboard workflow
  rather than a `flyctl`/`wrangler` one. Clear it, or run it in a window you
  close.
- Everything else is redacted. The dashboard, the status report, the import
  summary and the confirmation prompt show names and fingerprints only, so the
  reveal after a `y` is the single place in the tool a credential is printed.
- The store itself is plaintext, protected only by file mode 0600.
