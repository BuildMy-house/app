from __future__ import annotations

import json
import os
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class AxiomClient:
    """Minimal Axiom query client using only the Python standard library."""

    def __init__(self, token: str | None = None) -> None:
        self.token = token or os.environ.get("AXIOM_TOKEN", "")
        self.endpoint = os.environ.get("AXIOM_ENDPOINT", "https://api.axiom.co").rstrip("/")
        self.dataset = os.environ.get("AXIOM_DATASET", "homely-telemetry")

    def query(self, aql: str, *, timeframe: str = "24h") -> dict:
        url = f"{self.endpoint}/api/v1/datasets/{self.dataset}/_search"
        request = Request(
            url,
            data=json.dumps({"query": aql, "timeframe": timeframe}).encode(),
            method="POST",
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=30) as response:
                return json.loads(response.read())
        except HTTPError as exc:
            raise RuntimeError(f"Axiom query failed ({exc.code})") from exc

    def summary(self, metric: str = "errors", *, timeframe: str = "7d") -> dict:
        queries = {
            "errors": "['error.caught'] | stats count() as cnt by message | sort cnt desc | head 20",
            "performance": "['perf.frame_time'] | stats avg(p50) as avg_p50, avg(p95) as avg_p95, avg(p99) as avg_p99 by bin(1h, ts)",
            "usage": "['tool.switch', 'feature.undo', 'feature.redo', 'feature.room_add'] | stats count() as cnt by event | sort cnt desc",
        }
        if metric not in queries:
            raise ValueError(f"Unknown metric: {metric}. Choose from: {', '.join(queries)}")
        return self.query(queries[metric], timeframe=timeframe)
