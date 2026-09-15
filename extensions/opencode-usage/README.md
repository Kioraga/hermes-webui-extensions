# OpenCode Usage

**OpenCode Usage** is a trusted local Hermes WebUI extension that adds a titlebar
button opening a panel with the usage of both OpenCode gateways:

- **OpenCode Go** — the plan's own windows (rolling 5 h, weekly, monthly), as
  percentages with their reset times, straight from OpenCode's usage endpoint.
- **OpenCode Zen** — consumption measured *locally*: the usage Hermes itself
  recorded for Zen-billed models, grouped into the same three windows and priced
  with Zen's published list prices.

## What It Does

- Adds an **OpenCode** button to the app titlebar (next to Reload) that toggles a
  panel. `Escape`, the close button, or a click outside dismisses it.
- **Go section**: one bar per plan window with the percent, the window status, and
  a live "resets in …" countdown derived from OpenCode's `resetsAt`.
- **Zen section**: window tabs (5 h / 7 d / 30 d) and a per-model table
  (requests, input/output/cache-read tokens, estimated cost) plus a total.
- Configurable in **Settings → Extensions → OpenCode Usage**: auto-refresh on/off,
  refresh interval, and which window the panel opens on.

## Why Zen is an estimate and Go is not

`GET https://opencode.ai/zen/go/v1/usage` is a real, documented endpoint: it
returns the Go plan's window percentages and reset timestamps. That is OpenCode's
own accounting and this extension shows it verbatim.

**Zen has no equivalent API.** Every candidate path (`/zen/v1/balance`,
`/zen/v1/usage`, `/zen/v1/credits`, `/zen/v1/account`, `/zen/v1/me`) returns 404;
the upstream request for a balance endpoint (anomalyco/opencode#10448) has been
open since January 2026 and the maintainers’ answer has been that it needs
server-side work. So instead of scraping a dashboard with a session cookie, this
extension reports **what Hermes recorded**: the `session_model_usage` table in
`~/.hermes/state.db`, filtered to Zen-billed rows, priced with Zen's published
list prices.

The Zen figures are therefore **an estimate of spend, not an account balance**,
and the panel says so. Use OpenCode's dashboard when you need the real balance.

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets (/extensions/opencode-usage/assets/*)
  -> titlebar button -> panel
  -> same-origin sidecar proxy: /api/extensions/opencode-usage/sidecar/api/usage
  -> sidecar (127.0.0.1:17799, token-v1)
       -> GET opencode.ai/zen/go/v1/usage        (Go API key, live plan windows)
       -> ~/.hermes/state.db, SQLite mode=ro     (Zen local accounting)
       -> ~/.hermes/.env                         (keys, when not in the environment)
```

The browser never sees the API keys; they live in the sidecar process only.

## Capabilities

- `manifest-bundle`
- `loopback-sidecar`
- `extension-settings`

## Install

1. **Install the extension.** From the gallery (Settings → Extensions) or by
   copying this directory to `~/.hermes/webui/extensions/opencode-usage/`.
2. **Start the sidecar.**

   ```bash
   cp ~/.hermes/webui/extensions/opencode-usage/sidecar/opencode-usage-sidecar.service \
      ~/.config/systemd/user/
   systemctl --user enable --now opencode-usage-sidecar
   curl -s http://127.0.0.1:17799/health
   ```

   Any other way of running `sidecar/sidecar.py` works too, as long as
   `HERMES_WEBUI_STATE_DIR` points at the WebUI state dir so the sidecar finds the
   proxy token.
3. **Approve the sidecar proxy** in **Settings → Extensions → Diagnostics → the
   "Loopback sidecar" card → "Approve proxy consent"** for OpenCode Usage. This is
   what lets the browser reach the sidecar through the WebUI instead of guessing a
   loopback port.
4. **Enable WebUI authentication** (Settings → Password) if it is off. The
   `token-v1` proxy is deliberately fail-closed without it, because an
   unauthenticated WebUI would otherwise act as a token-bearing forwarding oracle
   for any local process.
5. **Have a key.** `OPENCODE_GO_API_KEY` (or the legacy `OPENCODE_API_KEY`) in the
   sidecar's environment or in `~/.hermes/.env`. `OPENCODE_ZEN_API_KEY` is only
   reported as present/absent — Zen figures do not need a key.

## Disable And Uninstall

- Disable the extension: Settings → Extensions → toggle it off (or set
  `"enabled": false` in the manifest), then reload the WebUI.
- Stop the sidecar: `systemctl --user disable --now opencode-usage-sidecar`.
- Uninstall: remove `~/.hermes/webui/extensions/opencode-usage/`. Nothing is
  persisted outside it except the settings the browser stores for the extension
  id and the proxy token WebUI mints in `~/.hermes/webui/sidecar-auth/`.

## Trust And Permissions

This is trusted local code running with WebUI session authority.

Browser assets (`assets/opencode-usage.js` / `.css`):

- create extension-owned DOM (a titlebar button and a `position: fixed` panel)
  and never mutate core views;
- call exactly two same-origin endpoints: `GET /api/extensions/status` (to
  explain a missing sidecar/proxy consent) and
  `GET /api/extensions/opencode-usage/sidecar/api/usage`;
- contact **no** external origin — there is no third-party URL in the assets;
- read/write a small set of preferences through the sanctioned
  `HermesExtensionSettings` accessors, with a namespaced `localStorage` fallback
  (`hermes-ext-opencode-usage`) for older core;
- never touch cookies, the clipboard, or the filesystem.

Sidecar (`sidecar/`, testable in isolation):

- reads the API keys from its own environment or `~/.hermes/.env`;
- makes one outbound `GET` to `opencode.ai/zen/go/v1/usage` with the Go key;
- opens `~/.hermes/state.db` **read-only** (`file:…?mode=ro`) and reads only
  `session_model_usage`;
- writes nothing, anywhere;
- never returns a key, and does not log requests (the scaffold suppresses request
  logging so an `Authorization` header cannot land in a log).

**Scope, stated honestly.** The `token-v1` token converts "any local process that
can reach the loopback port" into "processes that can read the user's WebUI state
dir". It does **not** defend against arbitrary same-UID code, which can read the
token file or read your `.env` directly. Nothing here changes that.

## Sidecar

- Origin `http://127.0.0.1:17799`, health path `/health`, `proxy_auth: token-v1`.
- Vendored runtime at `sidecar/`; `sidecar_base.py` and `sidecar.py` are
  byte-identical to the canonical scaffold and must stay that way.
- One route: `GET /api/usage` (`?refresh=1` bypasses the 60 s plan cache). Both
  sources are read-only, so there is no POST and no job/poll dance; the outbound
  call is capped at 6 s, inside the proxy's ~10 s buffered upstream timeout.
- `routes_impl.py` holds routes only; all logic is in `opencode_usage.py`.

### The User-Agent is load-bearing

OpenCode's edge rejects requests from generic HTTP-library user agents
(`URLError` → **HTTP 403, Cloudflare error 1010**). The sidecar therefore sends
`hermes-webui-ext-opencode-usage/<version>` and a stable `x-opencode-session`
header, which is also what OpenCode's Go documentation asks coding-agent clients
to send. A 403 is reported as `blocked`, not as an invalid key, so the panel does
not blame your credentials for an edge rejection.

## Known Limitations

- **No Zen balance.** Explained above; it is an upstream API gap, not a choice.
- **Zen/Go local windows are approximations.** `session_model_usage` rows are
  cumulative per (session, model, provider, task) with only `first_seen` /
  `last_seen` — Hermes stores no per-request timestamp series. A row is attributed
  to a window **whole** when its `last_seen` falls inside it, so a long session
  that straddles a boundary counts entirely in the later window. The windows are
  trailing (now − 5 h / 7 d / 30 d) and are **not** the plan's reset-anchored
  windows — only the Go section's percentages come from OpenCode.
- **Prices drift.** The embedded price table mirrors Zen's published list prices
  at the time of writing. Models with a context-tier split use the base tier.
  Models missing from the table are listed as unpriced and excluded from the
  total rather than guessed at.
- **Go's cost column is informational.** Go is a flat monthly subscription, so
  its estimated cost is the *list-price value* of what you consumed, not a charge.
- **Loopback only.** Sidecars cannot work against a bridge-networked WebUI
  container: `127.0.0.1` is namespace-local, so core and sidecar must share a
  network namespace and the state dir.
- The panel anchors to `.app-titlebar` and inserts before `#btnReload`; a core
  rename of those would require an update — standard for a DOM-injection
  extension.

## Compatibility

- manifest-bundled extension assets served same-origin under `/extensions/`
- loopback sidecar with `proxy_auth: token-v1` and the consent-gated proxy at
  `/api/extensions/<id>/sidecar/…`
- `extension-settings`: `HermesExtensionSettings.settingsForExtension(id)` with
  `settings_schema` + `permissions.storage.owned: true`
- DOM integration point: `.app-titlebar` and `#btnReload`
- WebUI API surface: `GET /api/extensions/status`

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/sync-sidecar-base.mjs --check
node scripts/check-sidecar-usage.mjs
node --check extensions/opencode-usage/assets/opencode-usage.js
python3 -m json.tool extensions/opencode-usage/extension.json
python3 -m json.tool extensions/opencode-usage/manifest.json
```

Sidecar route behaviour, with the service running:

```bash
# tokenless probe: the scaffold denies by default
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17799/api/usage      # 503 (no token file / no header)
curl -s http://127.0.0.1:17799/health                                          # {"ok":true,...} — the only tokenless route
```

Manual verification:

- the titlebar shows an **OpenCode** button before Reload; clicking it opens the
  panel and the Go bars match `GET opencode.ai/zen/go/v1/usage` for your key
- the percent bars and "resets in …" countdowns agree with the raw endpoint
- the Zen tabs switch windows and the per-model totals match
  `sqlite3 ~/.hermes/state.db "select … from session_model_usage"`
- with the sidecar stopped, the panel explains that the sidecar is not answering
  instead of showing empty bars
- with proxy consent revoked, the panel points at Settings → Extensions
- `Escape`, the ✕ button, and a click outside all dismiss the panel
