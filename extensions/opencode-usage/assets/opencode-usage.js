(() => {
  'use strict';

  // ── OpenCode Go Usage extension for Hermes WebUI ─────────────────────────
  // Adds a status chip to the composer footer, right after .composer-divider,
  // that opens a panel with the OpenCode Go plan usage: the plan's own live
  // windows (rolling / weekly / monthly percent + reset time) straight from the
  // sidecar, which calls OpenCode's documented /zen/go/v1/usage endpoint. Once
  // data arrives the chip itself shows the three percentages ("Go: x%·y%·z%").
  // Hovering the chip opens the panel; it stays pinned (fixed size, not closed
  // on mouse-out) until dismissed by Escape / an outside click / clicking the
  // chip again.
  //
  // All HTTP goes through the consented loopback-sidecar proxy at
  // /api/extensions/opencode-usage/sidecar/… — the API key stays in the sidecar
  // process and never reaches the browser. This file makes no other network call
  // and contacts no external origin.

  const EXT = 'opencode-usage';
  if (window.__hermesOpenCodeUsageLoaded) return;
  window.__hermesOpenCodeUsageLoaded = true;

  const BASE = '/api/extensions/' + EXT + '/sidecar';
  const STATUS_URL = '/api/extensions/status';
  const FALLBACK_KEY = 'hermes-ext-opencode-usage';
  const DEFAULTS = { auto_refresh: true, refresh_seconds: 60 };
  const WINDOW_LABELS = { rolling: '5-hour Usage', weekly: 'Weekly Usage', monthly: 'Monthly Usage' };
  const PERCENT_ORDER = ['rolling', 'weekly', 'monthly'];
  const BUTTON_LABEL = 'OpenCode Go';
  const MOUNT_RETRY_MS = 400;
  const MOUNT_MAX_TRIES = 25;
  const HOVER_OPEN_DELAY = 160;

  let panel = null;
  let button = null;
  let lastFocus = null;
  let timer = null;
  let outsideHandler = null;
  let keyHandler = null;
  let composerObserver = null;
  let hoverOpenTimer = null;
  let lastPayload = null;
  let fixedPanelHeight = null;
  let busy = false;

  // ── extension settings (sanctioned accessors, with a localStorage fallback) ─

  function settingsHandle() {
    try {
      const api = window.HermesExtensionSettings;
      if (!api || typeof api.settingsForExtension !== 'function') return null;
      const handle = api.settingsForExtension(EXT);
      if (!handle || handle.supported === false) return null;
      return handle;
    } catch (_) { return null; }
  }

  function readFallback() {
    try {
      const raw = localStorage.getItem(FALLBACK_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) { return {}; }
  }

  function writeFallback(patch) {
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(Object.assign(readFallback(), patch)));
    } catch (_) { /* storage disabled: settings simply do not persist */ }
  }

  function getSetting(key) {
    const handle = settingsHandle();
    if (handle) {
      try {
        const value = handle.get(key);
        if (value !== undefined && value !== null) return value;
      } catch (_) { /* fall through to the fallback store */ }
    }
    const stored = readFallback();
    return Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : DEFAULTS[key];
  }

  function setSetting(key, value) {
    const handle = settingsHandle();
    if (handle) {
      try { handle.set(key, value); return; } catch (_) { /* fall through */ }
    }
    writeFallback({ [key]: value });
  }

  function refreshSeconds() {
    const raw = Number(getSetting('refresh_seconds'));
    if (!Number.isFinite(raw)) return DEFAULTS.refresh_seconds;
    return Math.min(3600, Math.max(15, Math.round(raw)));
  }

  function autoRefreshEnabled() {
    return getSetting('auto_refresh') !== false;
  }

  // ── formatting helpers ─────────────────────────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function fmtClock(epochSeconds) {
    const n = Number(epochSeconds);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  // "resets in 3 h 12 min" — the raw value is an ISO timestamp from OpenCode.
  function fmtResetIn(iso) {
    if (!iso) return '';
    const when = Date.parse(iso);
    if (!Number.isFinite(when)) return '';
    const delta = Math.max(0, when - Date.now());
    const minutes = Math.floor(delta / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    if (days > 0) return 'Resets in ' + days + ' d ' + hours + ' h';
    if (hours > 0) return 'Resets in ' + hours + ' h ' + mins + ' min';
    return 'Resets in ' + mins + ' min';
  }

  // One decimal so small plan windows stay readable (11 → 11.0%).
  function fmtPercent(percent) {
    const n = Number(percent);
    return Number.isFinite(n) ? n.toFixed(1) + '%' : '—';
  }

  function pctClass(percent, status) {
    const s = String(status || '').toLowerCase();
    if (s && s !== 'ok') return ' hwx-ocu-bar-fill--err';
    const n = Number(percent);
    if (!Number.isFinite(n)) return '';
    if (n >= 90) return ' hwx-ocu-bar-fill--err';
    if (n >= 70) return ' hwx-ocu-bar-fill--warn';
    return '';
  }

  // ── usage fetch + diagnostics ──────────────────────────────────────────────

  async function fetchJSON(url) {
    const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    return { status: res.status, ok: res.ok, body };
  }

  async function sidecarRecord() {
    try {
      const res = await fetchJSON(STATUS_URL);
      const list = res.body && Array.isArray(res.body.sidecars) ? res.body.sidecars : [];
      return list.find((entry) => entry && entry.id === EXT) || null;
    } catch (_) { return null; }
  }

  // Turn an HTTP failure of the proxy (or the sidecar itself) into something the
  // operator can act on, using core's own sidecar record for context.
  function diagnose(status, record) {
    const proxy = (record && record.proxy) || {};
    if (status === 403) {
      if (proxy.posture === 'local_unprotected') {
        return {
          title: 'WebUI authentication is off',
          detail: 'The token-v1 sidecar proxy fails closed without authentication, so no '
            + 'local process can use WebUI as a key-forwarding intermediary. Enable a '
            + 'password in Settings → Password, then approve the proxy.',
        };
      }
      return {
        title: 'Sidecar proxy not approved yet',
        detail: 'Approve it in Settings → Extensions → Diagnostics → "Loopback sidecar" '
          + 'card → "Approve proxy consent" for OpenCode Go Usage.',
      };
    }
    if (status === 401 || status === 503) {
      return {
        title: 'Sidecar rejected the proxy token',
        detail: 'The sidecar is running but is not reading the same token as WebUI (or the '
          + 'token file does not exist yet). Make sure the sidecar and WebUI share the same '
          + 'state dir (~/.hermes/webui) and restart opencode-usage-sidecar.',
      };
    }
    if (status === 404) {
      return {
        title: 'Extension not enabled',
        detail: 'The manifest does not declare the opencode-usage sidecar, or the extension '
          + 'is disabled. Reload the WebUI and check Settings → Extensions.',
      };
    }
    // 502/504 and network failures are what a dead sidecar actually looks like:
    // the proxy cannot reach 127.0.0.1:17799.
    return {
      title: 'Sidecar is not responding',
      detail: 'The proxy could not reach 127.0.0.1:17799. Start the sidecar service '
        + '(`systemctl --user enable --now opencode-usage-sidecar`) and try again. '
        + (status ? 'The proxy returned HTTP ' + status + '.' : ''),
    };
  }

  // ── composer chip label ───────────────────────────────────────────────────

  function usageLabel(payload) {
    const plan = (payload && payload.go && payload.go.plan) || {};
    if (!plan.available) return BUTTON_LABEL;
    const windows = plan.windows || {};
    const parts = PERCENT_ORDER.map((key) => {
      const entry = windows[key] || {};
      const percent = Number(entry.percent);
      return Number.isFinite(percent) ? String(percent) + '%' : '—';
    });
    return 'Go: ' + parts.join('·');
  }

  function setButtonLabel(text) {
    if (!button) return;
    const label = button.querySelector('.hwx-ocu-btn-label');
    if (label) label.textContent = text;
    button.classList.toggle('hwx-ocu-btn--live', text !== BUTTON_LABEL);
  }

  // Populate the chip on page load so the percentages are visible without
  // opening the panel first. Any failure keeps the plain label.
  async function refreshButtonLabel() {
    try {
      const res = await fetchJSON(BASE + '/api/usage');
      if (res.ok && res.body) {
        lastPayload = res.body;
        setButtonLabel(usageLabel(res.body));
      }
    } catch (_) { /* keep the plain label */ }
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function windowBar(key, percent, status, resetsAt) {
    const row = el('div', 'hwx-ocu-window');
    const top = el('div', 'hwx-ocu-window-top');
    top.appendChild(el('span', 'hwx-ocu-window-label', WINDOW_LABELS[key] || key));
    row.appendChild(top);

    const barRow = el('div', 'hwx-ocu-window-bar-row');
    const bar = el('div', 'hwx-ocu-bar');
    const fill = el('div', 'hwx-ocu-bar-fill' + pctClass(percent, status));
    const width = Number.isFinite(Number(percent)) ? Math.min(100, Math.max(0, Number(percent))) : 0;
    fill.style.width = width + '%';
    bar.appendChild(fill);
    barRow.appendChild(bar);
    barRow.appendChild(el('span', 'hwx-ocu-window-pct', fmtPercent(percent)));
    row.appendChild(barRow);

    const reset = fmtResetIn(resetsAt);
    if (reset) row.appendChild(el('div', 'hwx-ocu-window-reset', reset));
    return row;
  }

  // The panel header already carries the "OpenCode Go Usage" title, the
  // updated stamp and the refresh control; the body only holds the window
  // bars (+ any error text).
  function renderGo(body, payload) {
    const go = (payload && payload.go) || {};
    const plan = go.plan || {};

    if (plan.available) {
      PERCENT_ORDER.forEach((key) => {
        const window = (plan.windows || {})[key];
        if (!window) return;
        body.appendChild(windowBar(key, window.percent, window.status, window.resets_at));
      });
    } else {
      const error = String(plan.error || 'unknown');
      const messages = {
        no_key: 'No OPENCODE_GO_API_KEY (nor OPENCODE_API_KEY) is available to the sidecar '
          + 'environment or ~/.hermes/.env.',
        invalid_key: 'OpenCode rejected the Go key (HTTP 401).',
        blocked: 'OpenCode\u2019s edge blocked the request (HTTP 403).',
        unreachable: 'OpenCode could not be reached from the sidecar.',
      };
      body.appendChild(el('p', 'hwx-ocu-note',
        messages[error] || ('The quota lookup failed (' + error + ').')));
    }
  }

  function renderError(body, title, detail) {
    const section = el('section', 'hwx-ocu-section');
    section.appendChild(el('div', 'hwx-ocu-error-title', title));
    if (detail) section.appendChild(el('p', 'hwx-ocu-note', detail));
    body.appendChild(section);
  }

  // Pin the panel to the tallest its content has ever been (the Go windows),
  // grow-only, so it never shrinks when a refresh re-renders a smaller state.
  // The body scrolls inside the fixed height.
  function ensurePanelHeight() {
    if (!panel) return;
    const bottom = window.parseInt(panel.style.bottom, 10) || 0;
    const avail = Math.max(120, window.innerHeight - bottom - 8);
    const measured = Math.max(120, Math.min(avail, panel.offsetHeight || 200));
    if (fixedPanelHeight === null || measured > fixedPanelHeight) {
      fixedPanelHeight = measured;
    }
    panel.style.height = fixedPanelHeight + 'px';
    panel.style.minHeight = fixedPanelHeight + 'px';
  }

  function render(payload, errorState) {
    if (!panel) return;
    const body = panel.querySelector('.hwx-ocu-body');
    if (!body) return;
    body.textContent = '';

    if (errorState) {
      renderError(body, errorState.title, errorState.detail);
    } else {
      renderGo(body, payload);
      ensurePanelHeight();
    }

    const stamp = panel.querySelector('.hwx-ocu-stamp');
    if (stamp) {
      const generated = payload && payload.generated_at;
      stamp.textContent = (errorState || !generated) ? '' : 'Updated ' + fmtClock(generated);
    }
  }

  function renderLoading() {
    if (!panel) return;
    const body = panel.querySelector('.hwx-ocu-body');
    if (!body) return;
    body.textContent = '';
    body.appendChild(el('div', 'hwx-ocu-empty', 'Querying OpenCode usage…'));
  }

  async function load(force) {
    if (busy) return;
    busy = true;
    const refreshBtn = panel && panel.querySelector('.hwx-ocu-refresh');
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.classList.add('hwx-ocu-refresh--active');
    }
    // Never collapse already-rendered content on a refresh: keep showing the
    // last payload until the fresh one lands, so the panel keeps its size.
    if (!lastPayload) renderLoading();
    try {
      const res = await fetchJSON(BASE + '/api/usage' + (force ? '?refresh=1' : ''));
      if (res.ok && res.body) {
        lastPayload = res.body;
        setButtonLabel(usageLabel(res.body));
        render(res.body, null);
      } else {
        const record = await sidecarRecord();
        render(null, diagnose(res.status, record));
      }
    } catch (_) {
      render(null, diagnose(0, await sidecarRecord()));
    } finally {
      busy = false;
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove('hwx-ocu-refresh--active');
      }
    }
  }

  // ── panel lifecycle ───────────────────────────────────────────────────────

  function scheduleRefresh() {
    stopRefresh();
    if (!autoRefreshEnabled()) return;
    const seconds = refreshSeconds();
    timer = window.setInterval(() => {
      if (panel && !document.hidden) load(false);
    }, seconds * 1000);
  }

  function stopRefresh() {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  function closePanel() {
    cancelHoverTimers();
    stopRefresh();
    if (outsideHandler) {
      document.removeEventListener('mousedown', outsideHandler, true);
      document.removeEventListener('click', outsideHandler, true);
    }
    if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
    outsideHandler = null;
    keyHandler = null;
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
    if (button && typeof button.focus === 'function') button.focus();
    lastFocus = null;
  }

  // ── hover behaviour ───────────────────────────────────────────────────────
  // Hovering the chip opens the panel after a short delay. Once open, the panel
  // stays **pinned**: it does not close when the cursor leaves (so a refresh or
  // a quick mouse movement does not dismiss it). It closes on Escape, on a click
  // anywhere outside, or by clicking the chip again.

  function cancelHoverTimers() {
    if (hoverOpenTimer) { window.clearTimeout(hoverOpenTimer); hoverOpenTimer = null; }
  }

  function hoverOpen() {
    if (panel) { cancelHoverTimers(); return; }
    if (hoverOpenTimer) return;
    hoverOpenTimer = window.setTimeout(() => {
      hoverOpenTimer = null;
      openPanel();
    }, HOVER_OPEN_DELAY);
  }

  function buildPanel() {
    const node = el('aside', 'hwx-ocu-panel');
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-label', 'OpenCode Go usage');

    const head = el('div', 'hwx-ocu-head');
    head.appendChild(el('span', 'hwx-ocu-head-title', 'OpenCode Go Usage'));
    head.appendChild(el('span', 'hwx-ocu-stamp', ''));

    const refreshBtn = el('button', 'hwx-ocu-icon-btn hwx-ocu-refresh');
    refreshBtn.appendChild(el('span', 'hwx-ocu-refresh-icon', '⟳'));
    refreshBtn.type = 'button';
    refreshBtn.title = 'Refresh now';
    refreshBtn.setAttribute('aria-label', 'Refresh now');
    refreshBtn.addEventListener('click', () => load(true));
    head.appendChild(refreshBtn);

    node.appendChild(head);
    node.appendChild(el('div', 'hwx-ocu-body', ''));
    return node;
  }

  // The panel grows to the RIGHT of the chip (left edges flush); its bottom
  // edge leaves room for the callout tail, aligned to the chip's centre.
  function placePanel() {
    if (!panel || !button) return;
    const anchor = button.getBoundingClientRect();
    const width = panel.offsetWidth || 360;
    let left = anchor.left;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (left < 8) left = 8;
    const bottom = Math.max(8, window.innerHeight - anchor.top + 8);
    panel.style.left = left + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = bottom + 'px';
    panel.style.top = 'auto';
    // Height is fixed in CSS so the panel never resizes between states.
    panel.style.setProperty('--hwx-ocu-tail-x', String(Math.max(12, anchor.width / 2)) + 'px');
  }

  function openPanel() {
    if (panel) { closePanel(); return; }
    lastFocus = document.activeElement;
    panel = buildPanel();
    panel.style.visibility = 'hidden';
    document.body.appendChild(panel);
    placePanel();
    // Render the freshest data we already have so the height is measured from
    // the full content before the panel is shown; load(false) then refreshes it.
    if (lastPayload) render(lastPayload, null); else renderLoading();
    panel.style.visibility = '';

    keyHandler = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closePanel();
      }
    };
    // Composer-tool behaviour: pressing any other control (or clicking anywhere
    // outside) dismisses the popover. Capture phase, so core's own handlers
    // cannot keep it open.
    outsideHandler = (event) => {
      if (!panel) return;
      if (panel.contains(event.target)) return;
      if (button && button.contains(event.target)) return;
      closePanel();
    };
    document.addEventListener('keydown', keyHandler, true);
    document.addEventListener('mousedown', outsideHandler, true);
    document.addEventListener('click', outsideHandler, true);

    load(false);
    scheduleRefresh();
  }

  // ── composer chip ─────────────────────────────────────────────────────────

  // A status chip, not a button: a <span> with no focus, no visual hover
  // affordance and no title tooltip. Hover opens the pinned panel; clicking it
  // toggles it (touch / explicit close).
  function buildButton() {
    const node = el('span', 'hwx-ocu-btn');
    node.id = 'btnOpenCodeUsage';
    node.appendChild(el('span', 'hwx-ocu-btn-label', BUTTON_LABEL));
    node.addEventListener('mouseenter', hoverOpen);
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      openPanel(); // toggles the pinned panel
    });
    return node;
  }

  function mount() {
    if (button && document.body.contains(button)) return true;
    const divider = document.querySelector('.composer-footer .composer-divider');
    if (!divider || !divider.parentNode) return false;
    if (!button) button = buildButton();
    // Chip in .composer-left, right after the divider.
    const next = divider.nextSibling;
    if (next) divider.parentNode.insertBefore(button, next);
    else divider.parentNode.appendChild(button);
    watchComposer();
    refreshButtonLabel();
    return true;
  }

  // The composer footer is static markup, but a panel switch can re-create it;
  // re-insert the chip if it ever leaves the DOM. The observer is scoped to one
  // node and re-checks containment, so our own insert cannot loop.
  function watchComposer() {
    if (composerObserver) return;
    const footer = document.querySelector('.composer-footer');
    if (!footer) return;
    composerObserver = new MutationObserver(() => {
      if (button && !document.body.contains(button)) mount();
    });
    composerObserver.observe(footer, { childList: true });
  }

  function mountWithRetry(attempt) {
    if (mount()) return;
    if (attempt >= MOUNT_MAX_TRIES) {
      console.warn('[' + EXT + '] composer footer not found; extension not mounted');
      return;
    }
    window.setTimeout(() => mountWithRetry(attempt + 1), MOUNT_RETRY_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mountWithRetry(0));
  } else {
    mountWithRetry(0);
  }
})();