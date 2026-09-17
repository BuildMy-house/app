"""Small, path-safe asset store used by the render worker."""
from __future__ import annotations

import re
from pathlib import Path

SAFE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


class AssetStore:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _check(value: str) -> None:
        if not SAFE.fullmatch(value):
            raise ValueError("invalid asset identifier")
