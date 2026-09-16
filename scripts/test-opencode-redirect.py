#!/usr/bin/env python3
"""Regression tests for the opencode-go-usage sidecar's credential safety.

The sidecar calls OpenCode's usage endpoint with an ``Authorization: Bearer``
header. urllib follows redirects while PRESERVING that header, so a redirect
would hand the API key to an unknown host. These tests assert that the sidecar
refuses any redirect (the redirect target is never contacted and never sees the
key) and that an oversized upstream body is rejected, keeping the payload inside
core's sidecar-proxy cap.
"""
from __future__ import annotations

import http.server
import importlib.util
import json
import sys
import threading
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SIDECAR_DIR = REPO_ROOT / "extensions" / "opencode-go-usage" / "sidecar"
_SOURCE = SIDECAR_DIR / "opencode_usage.py"
_SPEC = importlib.util.spec_from_file_location("opencode_go_usage_collector", _SOURCE)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"cannot load {_SOURCE}")
ocu = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = ocu
_SPEC.loader.exec_module(ocu)


class _TargetHandler(http.server.BaseHTTPRequestHandler):
    """The redirect destination — must never receive a request."""
    hits = 0

    def do_GET(self):  # noqa: N802
        type(self).hits += 1
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"usage":{}}')

    def log_message(self, *args):  # silence
        pass


class _OriginHandler(http.server.BaseHTTPRequestHandler):
    target = ("127.0.0.1", 0)
    body = b""
    redirect = True

    def do_GET(self):  # noqa: N802
        if self.redirect:
            host, port = self.target
            self.send_response(302)
            self.send_header("Location", f"http://{host}:{port}/landed")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *args):  # silence
        pass


class RedirectSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.servers: list[http.server.HTTPServer] = []

    def tearDown(self) -> None:
        for srv in self.servers:
            srv.shutdown()
            srv.server_close()

    def _serve(self, handler_cls) -> tuple[http.server.HTTPServer, tuple]:
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        self.servers.append(srv)
        return srv, srv.server_address

    def test_redirect_refused_key_never_leaks(self) -> None:
        target, target_addr = self._serve(_TargetHandler)
        origin, origin_addr = self._serve(_OriginHandler)
        _OriginHandler.target = target_addr

        old_url = ocu.GO_USAGE_URL
        ocu.GO_USAGE_URL = f"http://{origin_addr[0]}:{origin_addr[1]}/usage"
        try:
            result = ocu.go_plan("SUPER_SECRET_KEY_12345", force=True)
        finally:
            ocu.GO_USAGE_URL = old_url

        self.assertEqual(result.get("error"), "redirected")
        self.assertFalse(result.get("available", True))
        # The redirect destination must never be contacted — so it can never
        # observe the Authorization header.
        self.assertEqual(_TargetHandler.hits, 0)
        _TargetHandler.hits = 0

    def test_oversized_body_rejected(self) -> None:
        origin, origin_addr = self._serve(_OriginHandler)
        _OriginHandler.redirect = False
        _OriginHandler.body = b"a" * (ocu._MAX_UPSTREAM_BYTES + 1)  # > 64 KiB

        old_url = ocu.GO_USAGE_URL
        ocu.GO_USAGE_URL = f"http://{origin_addr[0]}:{origin_addr[1]}/usage"
        try:
            result = ocu.go_plan("KEY", force=True)
        finally:
            ocu.GO_USAGE_URL = old_url
            _OriginHandler.redirect = True

        self.assertEqual(result.get("error"), "unreachable")

    def test_normal_payload_parsed(self) -> None:
        origin, origin_addr = self._serve(_OriginHandler)
        _OriginHandler.redirect = False
        _OriginHandler.body = json.dumps({
            "usage": {
                "rolling": {"status": "ok", "percent": 9, "resetsAt": "2026-09-15T23:25:26Z"},
                "weekly": {"status": "ok", "percent": 25, "resetsAt": "2026-09-21T00:00:00Z"},
            }
        }).encode()
        old_url = ocu.GO_USAGE_URL
        ocu.GO_USAGE_URL = f"http://{origin_addr[0]}:{origin_addr[1]}/usage"
        try:
            result = ocu.go_plan("KEY", force=True)
        finally:
            ocu.GO_USAGE_URL = old_url
            _OriginHandler.redirect = True

        self.assertTrue(result.get("available"))
        self.assertEqual(result["windows"]["rolling"]["percent"], 9.0)
        self.assertEqual(result["windows"]["weekly"]["percent"], 25.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)