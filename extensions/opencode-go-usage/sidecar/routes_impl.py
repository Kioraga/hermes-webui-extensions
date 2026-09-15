"""Route implementations for the opencode-go-usage sidecar (token-v1 scaffold).

Every route here runs behind the scaffold's deny-by-default token guard
(``sidecar_base.py``); ``/health`` (scaffold-owned) is the only tokenless route.
The work lives in ``opencode_usage.py`` — this file only maps HTTP routes onto it
and shapes the JSON response.

Both routes are read-only: they read API keys (env or ``~/.hermes/.env``) to make
one outbound GET for the Go plan windows, and they aggregate Hermes' own
``state.db`` in read-only mode. Nothing here mutates state, so the only verb is
GET. The outbound call is capped at 6 s, comfortably inside the proxy's ~10 s
buffered upstream timeout, so no start-job/poll dance is needed.
"""
from __future__ import annotations

import opencode_usage


def _truthy(value) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def register(app) -> None:
    @app.route("GET", "/api/usage")
    def usage_get(req):
        # ``?refresh=1`` bypasses the 60 s plan cache (the UI's refresh button).
        return app.json(opencode_usage.build_payload(force=_truthy(req.query_one("refresh"))))
