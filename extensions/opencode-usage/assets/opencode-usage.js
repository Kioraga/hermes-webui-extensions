(() => {
  'use strict';

  // ── OpenCode Usage extension for Hermes WebUI ────────────────────────────
  // Adds a titlebar button that opens a panel with:
  //   * OpenCode Go  — the plan's own live windows (rolling / weekly / monthly
  //                    percent + reset time) straight from the sidecar, which
  //                    calls OpenCode's documented /zen/go/v1/usage endpoint.
  //   * OpenCode Zen — local accounting only. OpenCode exposes no Zen balance
  //                    or usage API, so the sidecar aggregates the usage Hermes
  //                    itself recorded (state.db → session_model_usage) and
  //                    prices it with Zen's published list prices. Estimated,
  //                    never presented as an account balance.
  //
  // All HTTP goes through the consented loopback-sidecar proxy at
  // /api/extensions/opencode-usage/sidecar/… — the API keys stay in the sidecar
  // process and never reach the browser. This file makes no other network call
  // and contacts no external origin.

  const EXT = 'opencode-usage';
  if (window.__hermesOpenCodeUsageLoaded) return;
  window.__hermesOpenCodeUsageLoaded = true;

  const BASE = '/api/extensions/' + EXT + '/sidecar';
  const STATUS_URL = '/api/extensions/status';
  const FALLBACK_KEY = 'hermes-ext-opencode-usage';
  const DEFAULTS = { auto_refresh: true, refresh_seconds: 60, default_window: 'rolling' };
  const WINDOW_LABELS = { rolling: '5 h', weekly: '7 d', monthly: '30 d' };
  const TITLEBAR_RETRY_MS = 400;
  const TITLEBAR_MAX_TRIES = 25;

  let panel = null;
  let button = null;
  let lastFocus = null;
  let timer = null;
  let outsideHandler = null;
  let keyHandler = null;
  let activeWindow = null;
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

  function modelsTable(local, windowKey) {
    const byWindow = (local && local.by_window) || {};
    const bucket = byWindow[windowKey] || {};
    const models = Array.isArray(bucket.models) ? bucket.models : [];
    if (!models.length) {
      return el('div', 'hwx-ocu-empty', 'No activity for this provider recorded by Hermes in this window.');
    }
    const table = el('table', 'hwx-ocu-table');
    const thead = el('thead');
    const headRow = el('tr');
    ['Model', 'Requests', 'Input', 'Output', 'Cache', '≈ Cost'].forEach((label) => {
      headRow.appendChild(el('th', null, label));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    let totalRequests = 0;
    let totalCost = 0;
    models.forEach((model) => {
      const row = el('tr');
      row.appendChild(el('td', 'hwx-ocu-model', model.model));
      row.appendChild(el('td', null, fmtInt(model.requests)));
      row.appendChild(el('td', null, fmtTokens(model.input_tokens)));
      row.appendChild(el('td', null, fmtTokens(model.output_tokens)));
      row.appendChild(el('td', 'hwx-ocu-dim', fmtTokens(model.cache_read_tokens)));
      row.appendChild(el('td', null, model.priced === false
        ? '—'
        : fmtUsd(model.estimated_cost_usd)));
      totalRequests += Number(model.requests || 0);
      totalCost += Number(model.estimated_cost_usd || 0);
      tbody.appendChild(row);
    });
    table.appendChild(tbody);

    const totalRow = el('tr', 'hwx-ocu-total');
    totalRow.appendChild(el('td', null, 'Total'));
    totalRow.appendChild(el('td', null, fmtInt(totalRequests)));
    totalRow.appendChild(el('td', null, ''));
    totalRow.appendChild(el('td', null, ''));
    totalRow.appendChild(el('td', null, ''));
    totalRow.appendChild(el('td', null, fmtUsd(totalCost)));
    tbody.appendChild(totalRow);
    return table;
  }

  function renderGo(body, payload) {
    const go = (payload && payload.go) || {};
    const plan = go.plan || {};
    const { section, badge } = sectionBlock('OpenCode Go', 'subscription plan');

    if (plan.available) {
      badge.textContent = 'live';
      badge.className = badgeClass('ok');
      const order = ['rolling', 'weekly', 'monthly'];
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

    const summary = localSummary(go.local, activeWindow);
    if (summary) section.appendChild(summary);
    body.appendChild(section);
  }

  function renderZen(body, payload, redraw) {
    const zen = (payload && payload.zen) || {};
    const local = zen.local || {};
    const { section, badge } = sectionBlock('OpenCode Zen', 'pay-as-you-go');
    badge.textContent = 'local';
    badge.className = badgeClass('warn');

    section.appendChild(el('p', 'hwx-ocu-note', zen.api_note
      || 'OpenCode publishes no Zen balance API; these figures are the usage Hermes recorded, not an account balance.'));
    section.appendChild(el('p', 'hwx-ocu-note',
      'Measured locally from ~/.hermes/state.db (session_model_usage).'));

    if (!local.available) {
      section.appendChild(el('p', 'hwx-ocu-note',
        'Could not read the local usage (' + String(local.error || 'error') + ').'));
      body.appendChild(section);
      return;
    }

    const tabs = el('div', 'hwx-ocu-tabs');
    Object.keys(WINDOW_LABELS).forEach((key) => {
      const tab = el('button', 'hwx-ocu-tab', WINDOW_LABELS[key]);
      tab.type = 'button';
      tab.setAttribute('aria-pressed', key === activeWindow ? 'true' : 'false');
      tab.addEventListener('click', () => {
        if (activeWindow === key) return;
        activeWindow = key;
        setSetting('default_window', key);
        redraw();
      });
      tabs.appendChild(tab);
    });
    section.appendChild(tabs);

    section.appendChild(modelsTable(local, activeWindow));

    const unpriced = Array.isArray(zen.estimate && zen.estimate.unpriced_models)
      ? zen.estimate.unpriced_models : [];
    if (unpriced.length) {
      section.appendChild(el('p', 'hwx-ocu-note',
        'No published Zen price, excluded from the estimate: ' + unpriced.join(', ') + '.'));
    }
    const basis = zen.estimate && zen.estimate.price_basis;
    if (basis) section.appendChild(el('p', 'hwx-ocu-note', 'Estimate: ' + basis + '.'));

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

    const redraw = () => render(payload, errorState);
    if (errorState) {
      renderMessage(body, errorState.title, errorState.detail);
    } else {
      renderGo(body, payload);
      renderZen(body, payload, redraw);
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
    node.setAttribute('aria-label', 'OpenCode Go and Zen usage');

    const head = el('div', 'hwx-ocu-head');
    head.appendChild(el('span', 'hwx-ocu-head-title', 'OpenCode'));
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
      'Go: plan usage queried from OpenCode · Zen: usage recorded by Hermes (state.db), not an account balance.');
    node.appendChild(foot);
    return node;
  }

  function openPanel() {
    if (panel) { closePanel(); return; }
    lastFocus = document.activeElement;
    panel = buildPanel();
    panel.style.visibility = 'hidden';
    document.body.appendChild(panel);
    // Clamp to the viewport once the panel has real dimensions.
    const rect = panel.getBoundingClientRect();
    if (rect.right > window.innerWidth - 4) {
      panel.style.right = '8px';
    }
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
    node.title = 'OpenCode Go and Zen usage';
    node.setAttribute('aria-label', 'OpenCode Go and Zen usage');
    node.setAttribute('aria-expanded', 'false');
    node.setAttribute('aria-haspopup', 'dialog');
    node.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M3 12a9 9 0 1 0 9-9"/><path d="M12 12l4.5-4.5"/><circle cx="12" cy="12" r="1.6"/></svg>'
      + '<span class="hwx-ocu-btn-label">OpenCode</span>';
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      openPanel();
    });
    return node;
  }

  function mount() {
    if (button && document.body.contains(button)) return true;
    const titlebar = document.querySelector('.app-titlebar');
    if (!titlebar) return false;
    button = buildButton();
    // Rightmost corner of the titlebar: append after Reload.
    titlebar.appendChild(button);
    return true;
  }

  function mountWithRetry(attempt) {
    if (mount()) return;
    if (attempt >= TITLEBAR_MAX_TRIES) {
      console.warn('[' + EXT + '] app titlebar not found; extension not mounted');
      return;
    }
    window.setTimeout(() => mountWithRetry(attempt + 1), TITLEBAR_RETRY_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mountWithRetry(0));
  } else {
    mountWithRetry(0);
  }
})();
