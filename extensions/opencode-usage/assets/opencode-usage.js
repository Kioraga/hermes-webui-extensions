(() => {
  'use strict';

  // ── OpenCode Go Usage extension for Hermes WebUI ─────────────────────────
  // Adds a chip to the composer footer, right after .composer-divider, that
  // opens a panel with the OpenCode Go plan usage: the plan's own live windows
  // (rolling / weekly / monthly percent + reset time) straight from the
  // sidecar, which calls OpenCode's documented /zen/go/v1/usage endpoint. Once
  // data arrives the chip itself shows the three percentages ("Go: x%·y%·z%").
  // A one-line summary also reports the usage Hermes recorded for Go models.
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
  const WINDOW_LABELS = { rolling: '5 h', weekly: '7 d', monthly: '30 d' };
  const PERCENT_ORDER = ['rolling', 'weekly', 'monthly'];
  const BUTTON_LABEL = 'OpenCode Go';
  const MOUNT_RETRY_MS = 400;
  const MOUNT_MAX_TRIES = 25;

  let panel = null;
  let button = null;
  let lastFocus = null;
  let timer = null;
  let outsideHandler = null;
  let keyHandler = null;
  let composerObserver = null;
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

  function fmtInt(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return '0';
    return Math.round(n).toLocaleString();
  }

  function fmtTokens(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' k';
    return String(Math.round(n));
  }

  function fmtUsd(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return '—';
    if (n === 0) return '$0';
    if (n < 0.01) return '$' + n.toFixed(4);
    return '$' + n.toFixed(2);
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
    if (days > 0) return 'resets in ' + days + ' d ' + hours + ' h';
    if (hours > 0) return 'resets in ' + hours + ' h ' + mins + ' min';
    return 'resets in ' + mins + ' min';
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

  function badgeClass(kind) {
    if (kind === 'err') return 'hwx-ocu-badge hwx-ocu-badge--err';
    if (kind === 'warn') return 'hwx-ocu-badge hwx-ocu-badge--warn';
    if (kind === 'ok') return 'hwx-ocu-badge hwx-ocu-badge--ok';
    return 'hwx-ocu-badge';
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
          + 'card → "Approve proxy consent" for OpenCode Usage.',
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
    const live = text !== BUTTON_LABEL;
    button.classList.toggle('hwx-ocu-btn--live', live);
    button.title = live ? 'OpenCode Go usage — ' + text : 'OpenCode Go usage';
    button.setAttribute('aria-label', live ? 'OpenCode Go usage: ' + text : 'OpenCode Go usage');
  }

  // Populate the chip on page load so the percentages are visible without
  // opening the panel first. Any failure keeps the plain label.
  async function refreshButtonLabel() {
    try {
      const res = await fetchJSON(BASE + '/api/usage');
      if (res.ok && res.body) setButtonLabel(usageLabel(res.body));
    } catch (_) { /* keep the plain label */ }
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function sectionBlock(title, sub) {
    const section = el('section', 'hwx-ocu-section');
    const head = el('div', 'hwx-ocu-section-head');
    head.appendChild(el('span', 'hwx-ocu-section-title', title));
    if (sub) head.appendChild(el('span', 'hwx-ocu-section-sub', sub));
    section.appendChild(head);
    const badge = el('span', 'hwx-ocu-badge');
    head.appendChild(badge);
    return { section, badge };
  }

  function windowBar(key, percent, status, resetsAt) {
    const row = el('div', 'hwx-ocu-window');
    const top = el('div', 'hwx-ocu-window-top');
    top.appendChild(el('span', 'hwx-ocu-window-label', WINDOW_LABELS[key] || key));
    top.appendChild(el('span', 'hwx-ocu-window-pct',
      Number.isFinite(Number(percent)) ? String(Number(percent)) + '%' : '—'));
    const reset = fmtResetIn(resetsAt);
    if (reset) top.appendChild(el('span', 'hwx-ocu-window-reset', reset));
    row.appendChild(top);
    const bar = el('div', 'hwx-ocu-bar');
    const fill = el('div', 'hwx-ocu-bar-fill' + pctClass(percent, status));
    const width = Number.isFinite(Number(percent)) ? Math.min(100, Math.max(0, Number(percent))) : 0;
    fill.style.width = width + '%';
    bar.appendChild(fill);
    row.appendChild(bar);
    return row;
  }

  function localSummary(local, windowKey) {
    const byWindow = (local && local.by_window) || {};
    const bucket = byWindow[windowKey];
    if (!bucket) return null;
    const line = el('p', 'hwx-ocu-note');
    const requests = Number(bucket.requests || 0);
    const inTok = Number(bucket.input_tokens || 0);
    const outTok = Number(bucket.output_tokens || 0);
    const cacheTok = Number(bucket.cache_read_tokens || 0);
    line.textContent = 'Measured by Hermes (' + (WINDOW_LABELS[windowKey] || windowKey) + '): '
      + fmtInt(requests) + (requests === 1 ? ' request' : ' requests')
      + ' · in ' + fmtTokens(inTok)
      + ' · out ' + fmtTokens(outTok)
      + (cacheTok > 0 ? ' · cache ' + fmtTokens(cacheTok) : '')
      + ' · list-price value ≈ ' + fmtUsd(bucket.estimated_cost_usd);
    return line;
  }

  function renderGo(body, payload) {
    const go = (payload && payload.go) || {};
    const plan = go.plan || {};
    const { section, badge } = sectionBlock('OpenCode Go', 'subscription plan');

    if (plan.available) {
      badge.textContent = 'live';
      badge.className = badgeClass('ok');
      const order = PERCENT_ORDER;
      order.forEach((key) => {
        const window = (plan.windows || {})[key];
        if (!window) return;
        section.appendChild(windowBar(key, window.percent, window.status, window.resets_at));
      });
      const stale = plan.cached ? ' · cached' : '';
      section.appendChild(el('div', 'hwx-ocu-section-sub',
        'Plan usage as reported by OpenCode' + stale
        + (plan.fetched_at ? ' · fetched ' + fmtClock(plan.fetched_at) : '')));
    } else {
      const error = String(plan.error || 'unknown');
      const messages = {
        no_key: 'No OPENCODE_GO_API_KEY (nor OPENCODE_API_KEY) is available to the sidecar '
          + 'environment or ~/.hermes/.env.',
        invalid_key: 'OpenCode rejected the Go key (HTTP 401).',
        blocked: 'OpenCode\u2019s edge blocked the request (HTTP 403).',
        unreachable: 'OpenCode could not be reached from the sidecar.',
      };
      badge.textContent = error === 'no_key' ? 'no key' : 'unavailable';
      badge.className = badgeClass(error === 'no_key' ? 'warn' : 'err');
      const note = el('p', 'hwx-ocu-note',
        messages[error] || ('The quota lookup failed (' + error + ').'));
      section.appendChild(note);
    }

    const summary = localSummary(go.local, 'rolling');
    if (summary) section.appendChild(summary);
    body.appendChild(section);
  }

  function renderMessage(body, title, detail) {
    const section = el('section', 'hwx-ocu-section');
    const { badge } = sectionBlock(title, '');
    badge.textContent = 'unavailable';
    badge.className = badgeClass('err');
    section.appendChild(el('p', 'hwx-ocu-note', detail || ''));
    body.appendChild(section);
  }

  function render(payload, errorState) {
    if (!panel) return;
    const body = panel.querySelector('.hwx-ocu-body');
    const stamp = panel.querySelector('.hwx-ocu-stamp');
    if (!body) return;
    body.textContent = '';

    if (errorState) {
      renderMessage(body, errorState.title, errorState.detail);
    } else {
      renderGo(body, payload);
    }

    if (stamp) {
      const generated = payload && payload.generated_at;
      stamp.textContent = errorState
        ? 'no data'
        : (generated ? 'updated ' + fmtClock(generated) : '');
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
    if (refreshBtn) refreshBtn.disabled = true;
    renderLoading();
    try {
      const res = await fetchJSON(BASE + '/api/usage' + (force ? '?refresh=1' : ''));
      if (res.ok && res.body) {
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
      if (refreshBtn) refreshBtn.disabled = false;
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
    stopRefresh();
    if (outsideHandler) document.removeEventListener('mousedown', outsideHandler, true);
    if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
    outsideHandler = null;
    keyHandler = null;
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
    if (button) {
      button.setAttribute('aria-expanded', 'false');
      button.focus();
    }
    lastFocus = null;
  }

  function buildPanel() {
    const node = el('aside', 'hwx-ocu-panel');
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-label', 'OpenCode Go usage');

    const head = el('div', 'hwx-ocu-head');
    head.appendChild(el('span', 'hwx-ocu-head-title', 'OpenCode Go'));
    head.appendChild(el('span', 'hwx-ocu-stamp', ''));

    const refreshBtn = el('button', 'hwx-ocu-icon-btn hwx-ocu-refresh', '⟳');
    refreshBtn.type = 'button';
    refreshBtn.title = 'Refresh now';
    refreshBtn.setAttribute('aria-label', 'Refresh now');
    refreshBtn.addEventListener('click', () => load(true));
    head.appendChild(refreshBtn);

    const closeBtn = el('button', 'hwx-ocu-icon-btn hwx-ocu-close', '✕');
    closeBtn.type = 'button';
    closeBtn.title = 'Close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', closePanel);
    head.appendChild(closeBtn);

    node.appendChild(head);
    node.appendChild(el('div', 'hwx-ocu-body', ''));

    const foot = el('div', 'hwx-ocu-foot',
      'OpenCode Go plan usage · queried from OpenCode.');
    node.appendChild(foot);
    return node;
  }

  // Anchor the popover above the chip and right-align it with the composer, the
  // way core's own composer dropdowns sit, then clamp it into the viewport.
  function placePanel() {
    if (!panel || !button) return;
    const anchor = button.getBoundingClientRect();
    const box = document.querySelector('.composer-box');
    const rightEdge = box ? box.getBoundingClientRect().right : (window.innerWidth - 12);
    const width = panel.offsetWidth || 360;
    let left = rightEdge - width;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (left < 8) left = 8;
    const bottom = Math.max(8, window.innerHeight - anchor.top + 8);
    panel.style.left = left + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = bottom + 'px';
    panel.style.top = 'auto';
    panel.style.maxHeight = Math.max(180, Math.min(620, window.innerHeight - bottom - 8)) + 'px';
  }

  function openPanel() {
    if (panel) { closePanel(); return; }
    lastFocus = document.activeElement;
    panel = buildPanel();
    panel.style.visibility = 'hidden';
    document.body.appendChild(panel);
    placePanel();
    panel.style.visibility = '';
    if (button) button.setAttribute('aria-expanded', 'true');

    keyHandler = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closePanel();
      }
    };
    outsideHandler = (event) => {
      if (!panel) return;
      if (panel.contains(event.target)) return;
      if (button && button.contains(event.target)) return;
      closePanel();
    };
    document.addEventListener('keydown', keyHandler, true);
    document.addEventListener('mousedown', outsideHandler, true);

    const closeBtn = panel.querySelector('.hwx-ocu-close');
    if (closeBtn) closeBtn.focus();

    load(false);
    scheduleRefresh();
  }

  // ── titlebar button ───────────────────────────────────────────────────────

  function buildButton() {
    const node = el('button', 'hwx-ocu-btn');
    node.type = 'button';
    node.id = 'btnOpenCodeUsage';
    node.title = 'OpenCode Go usage';
    node.setAttribute('aria-label', 'OpenCode Go usage');
    node.setAttribute('aria-expanded', 'false');
    node.setAttribute('aria-haspopup', 'dialog');
    node.appendChild(el('span', 'hwx-ocu-btn-label', BUTTON_LABEL));
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      openPanel();
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