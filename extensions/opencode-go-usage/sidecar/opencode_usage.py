"""OpenCode Go usage collector for the opencode-go-usage sidecar.

``GET https://opencode.ai/zen/go/v1/usage`` with the Go API key returns plan-window
percentages (rolling / weekly / monthly) plus each window's ``resetsAt``. That is
OpenCode's own accounting, so it is the authoritative number for the $10/month
plan. The payload the sidecar returns carries only that plan data (no local
accounting): it is small and constant-size, well inside core's sidecar-proxy cap.

Read-only: the sidecar writes no application or state data (Python may create
bounded bytecode caches in its own runtime directory). The Go API key is read
from the process environment or ``~/.hermes/.env`` and is never returned,
logged, or embedded in an error string.
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
_HTTP_TIMEOUT_SECONDS = 6.0
_PLAN_CACHE_SECONDS = 60.0
# Guard against a runaway upstream body (or a redirect payload) creeping past
# core's 512 KiB sidecar-proxy cap. The plan response is a few KB; 64 KiB is
# generous.
_MAX_UPSTREAM_BYTES = 64 * 1024

# OpenCode's edge rejects requests from generic HTTP-library user agents
# (Cloudflare error 1010 / HTTP 403), and its Go docs ask clients to identify
# themselves and to send a stable session id for routing + prompt-cache
# optimization. Both are required for /usage to return 200 at all.
_USER_AGENT = "hermes-webui-ext-opencode-go-usage/0.1.0"
_SESSION_ID = f"opencode-go-usage-sidecar-{uuid.uuid4()}"

# Windows in the plan payload, in display order.
_WINDOWS: Tuple[Tuple[str, str], ...] = (
    ("rolling", "5 h"),
    ("weekly", "7 d"),
    ("monthly", "30 d"),
)

# Key name for the Go plan lookup. OPENCODE_API_KEY is the legacy shared key
# that Hermes treats as enabling OpenCode Go too.
_GO_KEY_NAMES = ("OPENCODE_GO_API_KEY", "OPENCODE_API_KEY")


# ── redirect / body hardening ───────────────────────────────────────────────

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse ANY redirect for the credentialed request.

    urllib follows redirects while PRESERVING the Authorization header, so a
    redirect (captive portal, DNS interference, a compromised/changed endpoint)
    would hand the OpenCode API key to an unknown host. We fail instead.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(
            req.full_url, code, f"refusing redirect to {newurl}", headers, fp
        )


_OPENER = urllib.request.build_opener(_NoRedirect)

_plan_cache_lock = threading.Lock()
_plan_cache: Dict[str, Any] = {"at": 0.0, "payload": None}


# ── paths / keys ────────────────────────────────────────────────────────────

def hermes_home() -> Path:
    """Resolve the Hermes home whose ``.env`` we read.

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
    with _OPENER.open(req, timeout=_HTTP_TIMEOUT_SECONDS) as resp:
        raw = resp.read(_MAX_UPSTREAM_BYTES + 1)
    if len(raw) > _MAX_UPSTREAM_BYTES:
        raise ValueError("usage response exceeded size cap")
    payload = json.loads(raw.decode("utf-8"))
    usage = payload.get("usage") if isinstance(payload, dict) else None
    if not isinstance(usage, dict):
        raise ValueError("unexpected usage payload")

    windows: Dict[str, Any] = {}
    for key_name, label in _WINDOWS:
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
        # as its own code so the UI does not blame the API key. A redirect is
        # reported explicitly: we refuse to follow it (see _NoRedirect).
        if exc.code == 401:
            error = "invalid_key"
        elif exc.code == 403:
            error = "blocked"
        elif 300 <= exc.code < 400:
            error = "redirected"
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


# ── payload ─────────────────────────────────────────────────────────────────

def build_payload(*, force: bool = False) -> Dict[str, Any]:
    """The /api/usage payload: plan-only, small and constant-size.

    Deliberately does NOT aggregate Hermes' local state.db accounting: the
    frontend never reads it, and streaming it into the route is what let the
    payload outgrow core's 512 KiB proxy cap on long-lived instances.
    """
    dotenv = _read_dotenv()
    go_key, _go_source = resolve_key(_GO_KEY_NAMES, dotenv)
    return {
        "ok": True,
        "generated_at": time.time(),
        "go": {
            "plan": go_plan(go_key, force=force),
        },
    }