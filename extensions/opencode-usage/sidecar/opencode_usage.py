"""OpenCode Go / Zen usage collector for the opencode-usage sidecar.

Two sources, deliberately kept separate in the payload:

* **Go (live plan windows).** ``GET https://opencode.ai/zen/go/v1/usage`` with the
  Go API key returns plan-window percentages (rolling / weekly / monthly) plus
  each window's ``resetsAt``. This is OpenCode's own accounting, so it is the
  authoritative number for the $10/month plan.

* **Zen (local accounting only).** OpenCode exposes **no** balance/usage API for
  Zen (see opencode#10448) — every candidate path 404s. So Zen is reported from
  what Hermes itself recorded: the ``session_model_usage`` table in
  ``state.db``, grouped by billing provider/base URL, priced with Zen's published
  list prices to give an *estimate*. The extension must never present that
  estimate as an account balance.

Local-accounting approximation (documented in the README, surfaced in the
payload): ``session_model_usage`` rows are cumulative per
(session, model, provider, task) and carry only ``first_seen``/``last_seen`` —
there is no per-request timestamp series. A row is therefore attributed to a
window **whole** when its ``last_seen`` falls inside that window. Long sessions
that straddle a boundary land entirely in the later window; windows are trailing
(now − 5 h / 7 d / 30 d) and are not the plan's own reset anchored windows.

Read-only: this module opens ``state.db`` with ``mode=ro`` and never writes to the
Hermes state. API keys are read from the process environment or ``~/.hermes/.env``
and are never returned, logged, or embedded in an error string.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
_HTTP_TIMEOUT_SECONDS = 6.0
_PLAN_CACHE_SECONDS = 60.0
_MAX_MODEL_ROWS = 40

# OpenCode's edge rejects requests from generic HTTP-library user agents
# (Cloudflare error 1010 / HTTP 403), and its Go docs ask clients to identify
# themselves and to send a stable session id for routing + prompt-cache
# optimization. Both are required for /usage to return 200 at all.
_USER_AGENT = "hermes-webui-ext-opencode-usage/0.1.0"
_SESSION_ID = f"opencode-usage-sidecar-{uuid.uuid4()}"

# Windows as (key, label, seconds). Trailing windows for local accounting.
_WINDOWS: Tuple[Tuple[str, str, int], ...] = (
    ("rolling", "5 h", 5 * 3600),
    ("weekly", "7 d", 7 * 24 * 3600),
    ("monthly", "30 d", 30 * 24 * 3600),
)

# Zen published list prices, USD per 1M tokens:
# model id -> (input, output, cache_read, cache_write). Cache write omitted (0)
# where OpenCode publishes "-". Models with a <=/> context-tier split use the
# base tier; see PRICE_BASIS. Free models are 0.0.
PRICE_BASIS = (
    "Zen published list price (USD per 1M tokens), base context tier; "
    "unknown model ids are excluded from the estimate"
)
ZEN_PRICES: Dict[str, Tuple[float, float, float, float]] = {
    # Free tier
    "big-pickle": (0.0, 0.0, 0.0, 0.0),
    "mimo-v2.5-free": (0.0, 0.0, 0.0, 0.0),
    "ling-3.0-flash-fin-free": (0.0, 0.0, 0.0, 0.0),
    "nemotron-3-ultra-free": (0.0, 0.0, 0.0, 0.0),
    "nemotron-3.5-lightning-free": (0.0, 0.0, 0.0, 0.0),
    "muse-spark-1.3-contributor-free": (0.0, 0.0, 0.0, 0.0),
    # Open-weight models
    "deepseek-v4-flash": (0.14, 0.28, 0.028, 0.0),
    "deepseek-v4-flash-vision-exp": (0.14, 0.28, 0.028, 0.0),
    "deepseek-v4-pro": (1.74, 3.48, 0.145, 0.0),
    "minimax-m3": (0.30, 1.20, 0.06, 0.0),
    "minimax-m2.7": (0.30, 1.20, 0.06, 0.0),
    "minimax-m2.5": (0.30, 1.20, 0.06, 0.375),
    "glm-5.3-flash": (0.15, 0.50, 0.03, 0.0),
    "glm-5.3": (1.40, 4.40, 0.26, 0.0),
    "glm-5.2": (1.40, 4.40, 0.26, 0.0),
    "glm-5.1": (1.40, 4.40, 0.26, 0.0),
    "glm-5": (1.00, 3.20, 0.20, 0.0),
    "kimi-k3": (3.00, 15.00, 0.30, 0.0),
    "kimi-k2.7-code": (0.95, 4.00, 0.19, 0.0),
    "kimi-k2.6": (0.95, 4.00, 0.16, 0.0),
    "kimi-k2.5": (0.60, 3.00, 0.10, 0.0),
    "qwen3.7-max": (2.50, 7.50, 0.50, 3.125),
    "qwen3.7-plus": (0.40, 1.60, 0.04, 0.50),
    "qwen3.6-plus": (0.50, 3.00, 0.05, 0.625),
    "qwen3.5-plus": (0.20, 1.20, 0.02, 0.25),
    "grok-4.6": (2.00, 6.00, 0.50, 0.0),
    "grok-4.5": (2.00, 6.00, 0.30, 0.0),
    "grok-build-0.1": (1.00, 2.00, 0.20, 0.0),
    "muse-spark-1.3": (1.25, 4.25, 0.15, 0.0),
    "muse-spark-1.2": (1.25, 4.25, 0.15, 0.0),
    # Frontier models
    "claude-fable-5.1": (10.00, 50.00, 0.25, 12.50),
    "claude-fable-5": (10.00, 50.00, 1.00, 12.50),
    "claude-opus-5": (5.00, 25.00, 0.50, 6.25),
    "claude-opus-4.8": (5.00, 25.00, 0.50, 6.25),
    "claude-opus-4.7": (5.00, 25.00, 0.50, 6.25),
    "claude-opus-4.6": (5.00, 25.00, 0.50, 6.25),
    "claude-opus-4.5": (5.00, 25.00, 0.50, 6.25),
    "claude-sonnet-5": (2.00, 10.00, 0.20, 2.50),
    "claude-sonnet-4.6": (3.00, 15.00, 0.30, 3.75),
    "claude-sonnet-4.5": (3.00, 15.00, 0.30, 3.75),
    "claude-haiku-4.5": (1.00, 5.00, 0.10, 1.25),
    "gemini-3.8-flash": (1.50, 7.50, 0.15, 0.0),
    "gemini-3.7-flash": (1.50, 7.50, 0.15, 0.0),
    "gemini-3.6-flash": (1.50, 7.50, 0.15, 0.0),
    "gemini-3.5-flash": (1.50, 9.00, 0.15, 0.0),
    "gemini-3.5-flash-lite": (0.30, 2.50, 0.03, 0.0),
    "gemini-3.1-pro": (2.00, 12.00, 0.20, 0.0),
    "gemini-3-flash": (0.50, 3.00, 0.05, 0.0),
    "gpt-5.6-luna": (0.20, 1.20, 0.02, 0.25),
    "gpt-5.4-mini": (0.75, 4.50, 0.075, 0.0),
    "gpt-5.4-nano": (0.20, 1.25, 0.02, 0.0),
    "gpt-5-nano": (0.05, 0.40, 0.005, 0.0),
}

# Key names, most specific first. OPENCODE_API_KEY is the legacy shared key that
# Hermes treats as enabling both providers.
_GO_KEY_NAMES = ("OPENCODE_GO_API_KEY", "OPENCODE_API_KEY")
_ZEN_KEY_NAMES = ("OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY")

_plan_cache_lock = threading.Lock()
_plan_cache: Dict[str, Any] = {"at": 0.0, "payload": None}


# ── paths / keys ────────────────────────────────────────────────────────────

def hermes_home() -> Path:
    """Resolve the Hermes home whose ``.env`` and ``state.db`` we read.

    ``HERMES_HOME`` wins. Otherwise, when the unit (or the operator) sets
    ``HERMES_WEBUI_STATE_DIR`` — the canonical launch environment, which the
    systemd unit must contain — its ``webui`` layout implies the Hermes home as
    its parent. Falls back to ``~/.hermes``.
    """
    home = os.getenv("HERMES_HOME")
    if home:
        return Path(home).expanduser()
    state_dir = os.getenv("HERMES_WEBUI_STATE_DIR")
    if state_dir:
        state_path = Path(state_dir).expanduser()
        if state_path.name == "webui":
            return state_path.parent
    return Path.home() / ".hermes"


def dotenv_path() -> Path:
    return hermes_home() / ".env"


def state_db_path() -> Path:
    return hermes_home() / "state.db"


def _parse_dotenv(text: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if name:
            out[name] = value
    return out


def resolve_key(names: Tuple[str, ...], dotenv: Optional[Dict[str, str]] = None) -> Tuple[Optional[str], str]:
    """Return (key, source) where source is 'env', 'dotenv' or 'none'.

    The key value is only ever used to build an outbound Authorization header.
    """
    for name in names:
        value = os.getenv(name)
        if value and value.strip():
            return value.strip(), "env"
    if dotenv is None:
        dotenv = _read_dotenv()
    for name in names:
        value = dotenv.get(name)
        if value and value.strip():
            return value.strip(), "dotenv"
    return None, "none"


def _read_dotenv() -> Dict[str, str]:
    try:
        return _parse_dotenv(dotenv_path().read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        return {}


# ── Go plan windows (live) ──────────────────────────────────────────────────

def _fetch_go_plan(key: str) -> Dict[str, Any]:
    req = urllib.request.Request(
        GO_USAGE_URL,
        headers={
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "User-Agent": _USER_AGENT,
            "x-opencode-session": _SESSION_ID,
        },
    )
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SECONDS) as resp:
        raw = resp.read()
    payload = json.loads(raw.decode("utf-8"))
    usage = payload.get("usage") if isinstance(payload, dict) else None
    if not isinstance(usage, dict):
        raise ValueError("unexpected usage payload")

    windows: Dict[str, Any] = {}
    for key_name, label, _seconds in _WINDOWS:
        entry = usage.get(key_name)
        if not isinstance(entry, dict):
            continue
        percent = entry.get("percent")
        windows[key_name] = {
            "label": label,
            "status": str(entry.get("status") or "unknown"),
            "percent": round(float(percent), 2) if isinstance(percent, (int, float)) else None,
            "resets_at": entry.get("resetsAt"),
        }
    return {"windows": windows}


def go_plan(key: Optional[str], *, force: bool = False) -> Dict[str, Any]:
    """Cached (60 s) live plan windows. Never raises: returns an error field."""
    if not key:
        return {"available": False, "error": "no_key", "windows": {}}

    now = time.time()
    if not force:
        with _plan_cache_lock:
            cached_at = float(_plan_cache.get("at") or 0.0)
            cached = _plan_cache.get("payload")
            if cached is not None and (now - cached_at) < _PLAN_CACHE_SECONDS:
                out = dict(cached)
                out["cached"] = True
                return out

    try:
        data = _fetch_go_plan(key)
    except urllib.error.HTTPError as exc:
        # 401 = the key itself was rejected. 403 here is normally the edge
        # (Cloudflare 1010) refusing the client, not an auth failure — surfaced
        # as its own code so the UI does not blame the API key.
        if exc.code == 401:
            error = "invalid_key"
        elif exc.code == 403:
            error = "blocked"
        else:
            error = f"http_{exc.code}"
        return {"available": False, "error": error, "windows": {}}
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
        return {"available": False, "error": "unreachable", "windows": {}}

    result = {"available": True, "error": None, "fetched_at": now, "windows": data["windows"]}
    with _plan_cache_lock:
        _plan_cache["at"] = now
        _plan_cache["payload"] = dict(result)
    out = dict(result)
    out["cached"] = False
    return out


# ── local accounting (state.db) ─────────────────────────────────────────────

def _provider_class(billing_provider: str, billing_base_url: str) -> Optional[str]:
    """Map a usage row onto 'go' | 'zen' | None (not an OpenCode provider)."""
    url = (billing_base_url or "").lower()
    provider = (billing_provider or "").lower()
    haystack = f"{provider} {url}"
    if "opencode" not in haystack and "/zen/" not in haystack:
        return None
    if "/zen/go/" in url or "opencode-go" in provider or "opencode_go" in provider:
        return "go"
    if "/zen/" in url or "opencode-zen" in provider or "opencode_zen" in provider:
        return "zen"
    return None


def _estimate_cost(model: str, row: Dict[str, Any]) -> Optional[float]:
    prices = ZEN_PRICES.get((model or "").lower())
    if prices is None:
        return None
    per_in, per_out, per_cr, per_cw = prices
    cost = (
        row["input_tokens"] * per_in
        + row["output_tokens"] * per_out
        + row["cache_read_tokens"] * per_cr
        + row["cache_write_tokens"] * per_cw
    ) / 1_000_000.0
    return round(cost, 6)


def _empty_bucket() -> Dict[str, Any]:
    return {
        "requests": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "estimated_cost_usd": 0.0,
        "unpriced_requests": 0,
    }


def _add_row(bucket: Dict[str, Any], row: Dict[str, Any], cost: Optional[float]) -> None:
    bucket["requests"] += int(row["api_call_count"] or 0)
    bucket["input_tokens"] += int(row["input_tokens"] or 0)
    bucket["output_tokens"] += int(row["output_tokens"] or 0)
    bucket["cache_read_tokens"] += int(row["cache_read_tokens"] or 0)
    bucket["cache_write_tokens"] += int(row["cache_write_tokens"] or 0)
    if cost is None:
        bucket["unpriced_requests"] += int(row["api_call_count"] or 0)
    else:
        bucket["estimated_cost_usd"] = round(bucket["estimated_cost_usd"] + cost, 6)


def local_usage(class_name: str, *, now: Optional[float] = None) -> Dict[str, Any]:
    """Aggregate Hermes' own recorded OpenCode usage for 'go' or 'zen'."""
    now = time.time() if now is None else now
    db = state_db_path()
    if not db.exists():
        return {"available": False, "error": "state_db_missing", "by_window": {}, "models": []}

    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5.0)
    except sqlite3.Error:
        return {"available": False, "error": "state_db_unreadable", "by_window": {}, "models": []}

    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT model, billing_provider, billing_base_url, task, api_call_count,"
            " input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,"
            " first_seen, last_seen"
            " FROM session_model_usage"
        ).fetchall()
    except sqlite3.Error:
        return {"available": False, "error": "state_db_schema", "by_window": {}, "models": []}
    finally:
        conn.close()

    windows = {key: _empty_bucket() for key, _label, _s in _WINDOWS}
    by_window_models: Dict[str, Dict[str, Dict[str, Any]]] = {
        key: {} for key, _label, _s in _WINDOWS
    }
    models: Dict[str, Dict[str, Any]] = {}
    unpriced: set = set()

    for raw in rows:
        row = {k: raw[k] for k in raw.keys()}
        last_seen = row.get("last_seen")
        if not isinstance(last_seen, (int, float)):
            continue
        cls = _provider_class(str(row.get("billing_provider") or ""), str(row.get("billing_base_url") or ""))
        if cls != class_name:
            continue
        model = str(row.get("model") or "unknown")
        cost = _estimate_cost(model, row)
        if cost is None:
            unpriced.add(model)

        entry = models.setdefault(
            model,
            {"model": model, **_empty_bucket(), "last_seen": 0.0, "tasks": set()},
        )
        _add_row(entry, row, cost)
        entry["last_seen"] = max(float(entry["last_seen"]), float(last_seen))
        task = str(row.get("task") or "").strip()
        if task:
            entry["tasks"].add(task)

        for key, _label, seconds in _WINDOWS:
            if now - float(last_seen) <= seconds:
                _add_row(windows[key], row, cost)
                per_model = by_window_models[key].setdefault(model, _empty_bucket())
                _add_row(per_model, row, cost)

    model_list: List[Dict[str, Any]] = []
    for entry in sorted(models.values(), key=lambda e: e["requests"], reverse=True)[:_MAX_MODEL_ROWS]:
        model_list.append(
            {
                "model": entry["model"],
                "requests": entry["requests"],
                "input_tokens": entry["input_tokens"],
                "output_tokens": entry["output_tokens"],
                "cache_read_tokens": entry["cache_read_tokens"],
                "cache_write_tokens": entry["cache_write_tokens"],
                "estimated_cost_usd": entry["estimated_cost_usd"],
                "priced": entry["model"].lower() in ZEN_PRICES,
                "tasks": sorted(entry["tasks"]),
                "last_seen": entry["last_seen"],
            }
        )

    return {
        "available": True,
        "error": None,
        "totals": {
            "requests": sum(m["requests"] for m in model_list),
            "estimated_cost_usd": round(sum(m["estimated_cost_usd"] for m in model_list), 6),
        },
        "by_window": {
            key: {
                **windows[key],
                "models": [
                    {"model": name, **bucket}
                    for name, bucket in sorted(
                        by_window_models[key].items(),
                        key=lambda kv: kv[1]["requests"],
                        reverse=True,
                    )[:_MAX_MODEL_ROWS]
                ],
            }
            for key, _label, _s in _WINDOWS
        },
        "models": model_list,
        "unpriced_models": sorted(unpriced),
    }


# ── payload ─────────────────────────────────────────────────────────────────

def build_payload(*, force: bool = False) -> Dict[str, Any]:
    dotenv = _read_dotenv()
    go_key, go_source = resolve_key(_GO_KEY_NAMES, dotenv)
    zen_key, zen_source = resolve_key(_ZEN_KEY_NAMES, dotenv)

    go_local = local_usage("go")
    zen_local = local_usage("zen")

    return {
        "ok": True,
        "generated_at": time.time(),
        "windows": [{"key": k, "label": label, "seconds": s} for k, label, s in _WINDOWS],
        "go": {
            "key_present": bool(go_key),
            "key_source": go_source,
            "key_source_detail": "process env" if go_source == "env" else (
                str(dotenv_path()) if go_source == "dotenv" else None
            ),
            "plan": go_plan(go_key, force=force),
            "local": go_local,
        },
        "zen": {
            "key_present": bool(zen_key),
            "key_source": zen_source,
            "api_available": False,
            "api_note": (
                "OpenCode publishes no Zen balance/usage API; the local figures below are "
                "computed from Hermes' own recorded usage, not from the Zen account."
            ),
            "local": zen_local,
            "estimate": {
                "price_basis": PRICE_BASIS,
                "priced_models": sorted(
                    {m["model"] for m in zen_local.get("models", []) if m.get("priced")}
                ),
                "unpriced_models": zen_local.get("unpriced_models", []),
            },
        },
    }
