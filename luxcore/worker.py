"""Authenticated HTTP worker for final LuxCore renders."""
from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .render_jobs import RenderJobStore
from .profiles import settings_for


def make_handler(store: RenderJobStore, pool: ThreadPoolExecutor, token: str):
    class Handler(BaseHTTPRequestHandler):
        def _authorized(self) -> bool:
            if self.path == "/healthz":
                return True
            if self.headers.get("Authorization") != f"Bearer {token}":
                self._json(401, {"error": "unauthorized"})
                return False
            return True

        def _json(self, status: int, value: object) -> None:
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if not self._authorized():
                return
            parts = self.path.strip("/").split("/")
            if self.path == "/healthz":
                self._json(200, {"ok": True})
                return
            try:
                if len(parts) == 5 and parts[:3] == ["api", "render", "jobs"]:
                    self._json(200, store.get(parts[3], parts[4]))
                    return
                if len(parts) == 6 and parts[:3] == ["api", "render", "jobs"] and parts[5] == "artifact":
                    data = store.artifact(parts[3], parts[4])
                    self.send_response(200)
                    self.send_header("Content-Type", "image/png")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                self._json(404, {"error": "not found"})
            except (ValueError, OSError) as exc:
                self._json(404, {"error": str(exc)})

        def do_POST(self) -> None:
            if not self._authorized():
                return
            parts = self.path.strip("/").split("/")
            if len(parts) != 4 or parts[:3] != ["api", "render", "jobs"]:
                self._json(404, {"error": "not found"})
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                record = store.create(parts[3], body["scene"], settings_for(body.get("profile", "medium")))
                pool.submit(store.run, parts[3], record["id"])
                self._json(202, record)
            except (KeyError, ValueError, OSError, json.JSONDecodeError) as exc:
                self._json(400, {"error": str(exc)})

        def log_message(self, *_args: object) -> None:
            return

    return Handler


def main() -> None:
    token = os.environ.get("LUXCORE_WORKER_TOKEN")
    if not token:
        raise SystemExit("LUXCORE_WORKER_TOKEN is required")
    root = os.environ.get("LUXCORE_RENDER_ROOT", "var/renders")
    port = int(os.environ.get("PORT", "8081"))
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="luxcore")
    server = ThreadingHTTPServer((os.environ.get("HOST", "0.0.0.0"), port), make_handler(RenderJobStore(root), pool, token))
    try:
        server.serve_forever()
    finally:
        server.server_close()
        pool.shutdown(wait=True)


if __name__ == "__main__":
    main()
