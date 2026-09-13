"""Minimal stdlib asset API; put behind TLS/authentication in production."""
from __future__ import annotations

import base64
import json
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .asset_store import AssetStore
from .render_jobs import RenderJobStore


def make_handler(store: AssetStore, render_store: RenderJobStore | None = None,
                 render_pool: ThreadPoolExecutor | None = None):
    render_store = render_store or RenderJobStore("var/renders")
    render_pool = render_pool or ThreadPoolExecutor(max_workers=1, thread_name_prefix="luxcore")

    class Handler(BaseHTTPRequestHandler):
        def _json(self, status: int, value: object) -> None:
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            parts = self.path.strip("/").split("/")
            if len(parts) == 6 and parts[:3] == ["api", "render", "jobs"] and parts[5] == "artifact":
                try:
                    data = render_store.artifact(parts[3], parts[4])
                    self.send_response(200)
                    self.send_header("Content-Type", "image/png")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (ValueError, OSError) as exc:
                    self._json(404, {"error": str(exc)})
                return
            if len(parts) == 5 and parts[:3] == ["api", "render", "jobs"]:
                try:
                    self._json(200, render_store.get(parts[3], parts[4]))
                except (ValueError, OSError) as exc:
                    self._json(404, {"error": str(exc)})
                return
            if len(parts) == 5 and parts[:2] == ["api", "assets"] and parts[4] in ("model", "source"):
                try:
                    data = store.get(parts[2], parts[3], parts[4] == "source")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (ValueError, OSError) as exc:
                    self._json(404, {"error": str(exc)})
                return
            if len(parts) == 3 and parts[:2] == ["api", "assets"]:
                self._json(200, {"items": store.list(parts[2])})
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self) -> None:
            parts = self.path.strip("/").split("/")
            if len(parts) == 4 and parts[:3] == ["api", "render", "jobs"]:
                try:
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    record = render_store.create(parts[3], body["scene"], body.get("settings"))
                    render_pool.submit(render_store.run, parts[3], record["id"])
                    self._json(202, record)
                except (KeyError, ValueError, OSError, json.JSONDecodeError) as exc:
                    self._json(400, {"error": str(exc)})
                return
            if parts[:2] != ["api", "assets"] or len(parts) != 3:
                self._json(404, {"error": "not found"})
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                record = store.put(parts[2], body["record"], base64.b64decode(body["glb"]),
                                   base64.b64decode(body["source"]) if body.get("source") else None)
                self._json(201, record)
            except (KeyError, ValueError, OSError, json.JSONDecodeError) as exc:
                self._json(400, {"error": str(exc)})

        def do_DELETE(self) -> None:
            parts = self.path.strip("/").split("/")
            if len(parts) != 4 or parts[:2] != ["api", "assets"]:
                self._json(404, {"error": "not found"})
                return
            try:
                store.remove(parts[2], parts[3])
                self._json(200, {})
            except (ValueError, OSError) as exc:
                self._json(400, {"error": str(exc)})

        def log_message(self, *_args: object) -> None:
            return

    return Handler


def main() -> None:
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("var/assets"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8081)
    parser.add_argument("--render-root", type=Path, default=Path("var/renders"))
    args = parser.parse_args()
    ThreadingHTTPServer((args.host, args.port), make_handler(
        AssetStore(args.root), RenderJobStore(args.render_root))).serve_forever()


if __name__ == "__main__":
    main()
