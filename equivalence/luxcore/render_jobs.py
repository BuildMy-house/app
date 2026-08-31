"""Small durable render-job store for local and hosted deployments.

The web layer can enqueue jobs here and hand them to one worker process. The
store deliberately uses files, so the same contract works in an AppImage,
Deb install, or a remote server before a database is introduced.
"""
from __future__ import annotations

import json
import secrets
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .asset_store import SAFE
from .renderer import RenderSettings, render


class RenderJobStore:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def create(self, user_id: str, scene: dict[str, Any], settings: dict[str, Any] | None = None) -> dict[str, Any]:
        self._check(user_id)
        job_id = secrets.token_urlsafe(12)
        folder = self.root / user_id / job_id
        folder.mkdir(parents=True)
        self._write(folder / "scene.json", scene)
        record = {
            "id": job_id,
            "userId": user_id,
            "status": "queued",
            "settings": settings or {},
            "createdAt": self._now(),
            "scenePath": "scene.json",
        }
        self._write(folder / "job.json", record)
        return record

    def get(self, user_id: str, job_id: str) -> dict[str, Any]:
        folder = self._folder(user_id, job_id)
        return json.loads((folder / "job.json").read_text())

    def run(self, user_id: str, job_id: str) -> dict[str, Any]:
        folder = self._folder(user_id, job_id)
        record = self.get(user_id, job_id)
        if record["status"] == "completed":
            return record
        record = self._status(record, "running")
        self._write(folder / "job.json", record)
        try:
            scene = json.loads((folder / "scene.json").read_text())
            settings = RenderSettings(**record["settings"])
            output = folder / "render.png"
            render(scene, settings, output)
            record = self._status(record, "completed", artifactPath="render.png")
        except Exception as exc:  # noqa: BLE001
            (folder / "error.log").write_text(str(exc) + "\n")
            record = self._status(record, "failed", error=str(exc))
        self._write(folder / "job.json", record)
        return record

    def artifact(self, user_id: str, job_id: str) -> bytes:
        folder = self._folder(user_id, job_id)
        record = self.get(user_id, job_id)
        if record.get("status") != "completed":
            raise FileNotFoundError("render is not completed")
        return (folder / "render.png").read_bytes()

    def _folder(self, user_id: str, job_id: str) -> Path:
        self._check(user_id)
        self._check(job_id)
        folder = self.root / user_id / job_id
        if not (folder / "job.json").is_file():
            raise FileNotFoundError("render job not found")
        return folder

    @staticmethod
    def _status(record: dict[str, Any], status: str, **extra: Any) -> dict[str, Any]:
        return {**record, **extra, "status": status, "updatedAt": RenderJobStore._now()}

    @staticmethod
    def _now() -> str:
        return datetime.now(UTC).isoformat()

    @staticmethod
    def _check(value: str) -> None:
        if not SAFE.fullmatch(value):
            raise ValueError("invalid render job identifier")

    @staticmethod
    def _write(path: Path, value: object) -> None:
        data = json.dumps(value, indent=2) + "\n"
        with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False) as handle:
            handle.write(data)
            temp = Path(handle.name)
        temp.replace(path)
