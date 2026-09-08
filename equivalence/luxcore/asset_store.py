"""Durable per-user asset storage for the hosted renderer."""
from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

SAFE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


class AssetStore:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def list(self, user_id: str) -> list[dict[str, Any]]:
        manifest = self._manifest(user_id)
        return list(manifest.get("items", []))

    def put(self, user_id: str, record: dict[str, Any], glb: bytes,
            source: bytes | None = None) -> dict[str, Any]:
        self._check(user_id)
        asset_id = str(record["id"])
        self._check(asset_id)
        folder = self.root / user_id / asset_id
        folder.mkdir(parents=True, exist_ok=True)
        self._atomic(folder / "model.glb", glb)
        if source is not None:
            self._atomic(folder / "source.obj", source)
            record = {**record, "sourcePath": f"{asset_id}/source.obj"}
        record = {**record, "modelPath": f"{asset_id}/model.glb"}
        manifest = self._manifest(user_id)
        items = [item for item in manifest.get("items", []) if item.get("id") != asset_id]
        items.append(record)
        self._write_manifest(user_id, {"schemaVersion": 1, "items": items})
        return record

    def get(self, user_id: str, asset_id: str, source: bool = False) -> bytes:
        self._check(user_id)
        self._check(asset_id)
        return (self.root / user_id / asset_id / ("source.obj" if source else "model.glb")).read_bytes()

    def remove(self, user_id: str, asset_id: str) -> None:
        self._check(user_id)
        self._check(asset_id)
        manifest = self._manifest(user_id)
        self._write_manifest(user_id, {"schemaVersion": 1,
                                       "items": [i for i in manifest.get("items", []) if i.get("id") != asset_id]})

    def _check(self, value: str) -> None:
        if not SAFE.fullmatch(value):
            raise ValueError("invalid asset identifier")

    def _manifest(self, user_id: str) -> dict[str, Any]:
        self._check(user_id)
        path = self.root / user_id / "manifest.json"
        if not path.exists():
            return {"schemaVersion": 1, "items": []}
        return json.loads(path.read_text())

    def _write_manifest(self, user_id: str, value: dict[str, Any]) -> None:
        folder = self.root / user_id
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / "manifest.json"
        if path.exists():
            self._atomic(path.with_suffix(".json.bak"), path.read_bytes())
        self._atomic(path, (json.dumps(value, indent=2) + "\n").encode())

    @staticmethod
    def _atomic(path: Path, data: bytes) -> None:
        fd, temp = tempfile.mkstemp(prefix=".upload-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp, path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
