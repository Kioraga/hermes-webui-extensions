# OpenCode Go Usage

**OpenCode Go Usage** is a trusted local Hermes WebUI extension that adds a chip to
the composer footer (right after the model chip) opening a panel with the
**OpenCode Go plan usage**: the plan's own live windows — rolling 5 h, weekly and
monthly — as percentages with their reset times, straight from OpenCode's usage
endpoint. Once data arrives the chip itself shows those three percentages as
`Go: x%·y%·z%`.

## What It Does

- Adds a passive **OpenCode Go** status chip to the composer footer, right after
  the model chip (`.composer-model-wrap`), looking like the other `.composer-left`
  pills. It is **not a button**: no focus, no click, no hover
  highlight and no title tooltip. Hovering it opens the panel after a short delay;
  the panel stays **pinned** (it does not close when the cursor leaves) and is
  dismissed with `Escape`, clicking the chip again, or a click outside.
- The panel grows **to the right of the chip**, shows a small **callout tail**
  pointing down at the chip, and animates in (fade + 5 px nudge, `.14s` ease) —
  the same visual language as the context-window tooltip.
- As soon as usage is fetched the chip label becomes the three plan percentages,
  e.g. `Go: 11%·4%·23%` (rolling · weekly · monthly). Without data (sidecar down,
  no key) it stays `OpenCode Go`.
- Shows one bar per plan window (rolling 5 h / weekly / monthly) with the percent,
  the window status, and a live "resets in …" countdown derived from OpenCode's
  `resetsAt`.
- Configurable in **Settings → Extensions → OpenCode Go Usage**: auto-refresh
  on/off and the refresh interval.

## Data source

`GET https://opencode.ai/zen/go/v1/usage` is a documented endpoint that returns the
Go plan's window percentages and reset timestamps. This extension shows that
verbatim — it is OpenCode's own accounting, no scraping.

## Current Shape

```text
Hermes WebUI page
  -> manifest-bundled extension assets (/extensions/opencode-go-usage/assets/*)
  -> composer chip (right after the model chip) -> panel
  -> same-origin sidecar proxy: /api/extensions/opencode-go-usage/sidecar/api/usage
  -> sidecar (127.0.0.1:17799, token-v1)
       -> GET opencode.ai/zen/go/v1/usage        (Go API key, live plan windows)
       -> ~/.hermes/.env                         (key, when not in the environment)
```

The browser never sees the API key; it lives in the sidecar process only.

## Capabilities

- `manifest-bundle`
- `loopback-sidecar`

## Install

1. **Install the extension.** From the gallery (Settings → Extensions) or by
   copying this directory to `~/.hermes/webui/extensions/opencode-go-usage/`.
2. **Start the sidecar.**

   ```bash
   cp ~/.hermes/webui/extensions/opencode-go-usage/sidecar/opencode-go-usage-sidecar.service \
      ~/.config/systemd/user/
   systemctl --user enable --now opencode-go-usage-sidecar
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
   sidecar's environment or in `~/.hermes/.env`.

## Disable And Uninstall

- Disable the extension: Settings → Extensions → toggle it off (or set
  `"enabled": false` in the manifest), then reload the WebUI.
- Stop the sidecar: `systemctl --user disable --now opencode-go-usage-sidecar`.
- Uninstall: remove `~/.hermes/webui/extensions/opencode-go-usage/`. Nothing is
  persisted outside it except the settings the browser stores for the extension id
  and the proxy token WebUI mints in `~/.hermes/webui/sidecar-auth/`.

## Trust And Permissions

This is trusted local code running with WebUI session authority.

Browser assets (`assets/opencode-go-usage.js` / `.css`):

- create extension-owned DOM (a composer chip and a `position: fixed` panel) and
  never mutate core views;
- call exactly two same-origin endpoints: `GET /api/extensions/status` (to explain
  a missing sidecar/proxy consent) and
  `GET /api/extensions/opencode-go-usage/sidecar/api/usage`;
- contact **no** external origin — there is no third-party URL in the assets;
- read/write a small set of preferences through the sanctioned
  `HermesExtensionSettings` accessors, with a namespaced `localStorage` fallback
  (`hermes-ext-opencode-go-usage`) for older core;
- never touch cookies, the clipboard, or the filesystem.

Sidecar (`sidecar/`, testable in isolation):

- reads the Go API key from its own environment or `~/.hermes/.env`;
- makes one outbound `GET` to `opencode.ai/zen/go/v1/usage` with that key, refusing
  any redirect (so the key cannot follow a redirect to an unknown host) and capping
  the response size;
- writes no application or state data (Python may create bounded bytecode caches
  inside the sidecar's own directory);
- never returns the key, and does not log requests (the scaffold suppresses request
  logging so an `Authorization` header cannot land in a log).

**Scope, stated honestly.** The `token-v1` token converts "any local process that
can reach the loopback port" into "processes that can read the user's WebUI state
dir". It does **not** defend against arbitrary same-UID code, which can read the
token file or read your `.env` directly. Nothing here changes that.

## Sidecar

- Origin `http://127.0.0.1:17799`, health path `/health`, `proxy_auth: token-v1`.
- Vendored runtime at `sidecar/`; `sidecar_base.py` and `sidecar.py` are
  byte-identical to the canonical scaffold and must stay that way.
- One route: `GET /api/usage` (`?refresh=1` bypasses the 60 s plan cache). The
  outbound call is capped at 6 s and its body at 64 KiB, comfortably inside the
  proxy's ~10 s buffered upstream timeout and 512 KiB cap, so there is no
  job/poll dance. Redirects are refused outright.
- `routes_impl.py` holds routes only; all logic is in `opencode_usage.py`.

### The User-Agent is load-bearing

OpenCode's edge rejects requests from generic HTTP-library user agents
(`URLError` → **HTTP 403, Cloudflare error 1010**). The sidecar therefore sends
`hermes-webui-ext-opencode-go-usage/<version>` and a stable `x-opencode-session`
header, which is also what OpenCode's Go documentation asks coding-agent clients to
send. A 403 is reported as `blocked`, not as an invalid key, so the panel does not
blame your credentials for an edge rejection.

## Known Limitations

- **Loopback only.** Sidecars cannot work against a bridge-networked WebUI
  container: `127.0.0.1` is namespace-local, so core and sidecar must share a
  network namespace and the state dir.
- The chip mounts right after `.composer-model-wrap` inside `.composer-left` (beside
  `#providerQuotaChip`); a core rename of those would require an update — standard
  for a DOM-injection extension.

## Compatibility

- manifest-bundled extension assets served same-origin under `/extensions/`
- loopback sidecar with `proxy_auth: token-v1` and the consent-gated proxy at
  `/api/extensions/<id>/sidecar/…`
- `extension-settings`: `HermesExtensionSettings.settingsForExtension(id)` with
  `settings_schema` + `permissions.storage.owned: true`
- DOM integration point: `.composer-footer` → `.composer-model-wrap` (the chip is
  inserted right after it, inside `.composer-left`, beside `#providerQuotaChip`),
  and the panel grows to the right of the chip with a callout tail pointing at it.
  Styling mirrors the core composer chips (`.composer-*-chip`) and the
  context-window tooltip (`.ctx-tooltip`): `--surface` + `--border2` +
  `0 -4px 24px` shadow, `::after` tail and an opacity/translate entry animation.
  The chip uses core tokens (`--warning`, `--error`, `--accent-text`) for color.
- The chip hides on phones (`@media max-width: 640px`).
- WebUI API surface: `GET /api/extensions/status`

## Verification

```bash
node scripts/validate-extensions.mjs
node scripts/scan-extension-safety.mjs
node scripts/sync-sidecar-base.mjs --check
node scripts/check-sidecar-usage.mjs
node --check extensions/opencode-go-usage/assets/opencode-go-usage.js
python3 scripts/test-opencode-redirect.py
python3 -m json.tool extensions/opencode-go-usage/extension.json
python3 -m json.tool extensions/opencode-go-usage/manifest.json
```

Sidecar route behaviour, with the service running:

```bash
# tokenless probe: the scaffold denies by default
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17799/api/usage      # 503 (no token file / no header)
curl -s http://127.0.0.1:17799/health                                          # {"ok":true,...} — the only tokenless route
```

Manual verification:

- hovering the composer's **OpenCode Go** chip opens the panel to its right (with
  a callout tail and a fade-in); the chip label shows `Go: x%·y%·z%` matching
  `GET opencode.ai/zen/go/v1/usage` for your key; the panel stays pinned until
  `Escape`, clicking the chip again, or a click outside
- the percent bars and "resets in …" countdowns agree with the raw endpoint
- with the sidecar stopped, the panel explains that the sidecar is not answering
  instead of showing empty bars
- with proxy consent revoked, the panel points at Settings → Extensions →
  Diagnostics
- `Escape`, clicking the chip again, and a click outside all dismiss the panel
