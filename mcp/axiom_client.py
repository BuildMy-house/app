from __future__ import annotations

import json
import os
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class AxiomClient:
    """Minimal Axiom query client using only the Python standard library."""

    def __init__(self, token: str | None = None) -> None:
        self.token = token or os.environ.get("AXIOM_TOKEN", "")
        self.endpoint = os.environ.get("AXIOM_ENDPOINT", "").rstrip("/")
        self.dataset = os.environ.get("AXIOM_DATASET", "buildmy-house-telemetry")

    def query(self, aql: str, *, timeframe: str = "24h") -> dict:
        if not self.endpoint or not self.token:
            raise RuntimeError("Axiom is not configured: AXIOM_ENDPOINT/AXIOM_TOKEN must be set (no hardcoded fallback)")
        # Callers may pass a full APL pipeline (already starting with ['dataset']) or a bare
        # filter/aggregation fragment, in which case we scope it to our dataset + timeframe.
        apl = aql if aql.lstrip().startswith("[") else f"['{self.dataset}'] | where _time > ago({timeframe}) | {aql}"
        url = f"{self.endpoint}/v1/datasets/_apl?format=tabular"
        request = Request(
            url,
            data=json.dumps({"apl": apl}).encode(),
            method="POST",
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=30) as response:
                return json.loads(response.read())
        except HTTPError as exc:
            raise RuntimeError(f"Axiom query failed ({exc.code})") from exc

    def summary(self, metric: str = "errors", *, timeframe: str = "7d") -> dict:
        ds = self.dataset
        queries = {
            "errors": f"['{ds}'] | where _time > ago({timeframe}) | where event == 'error.caught' | summarize count() by message | sort by count_ desc | limit 20",
            "performance": f"['{ds}'] | where _time > ago({timeframe}) | where event == 'perf.frame_time' | summarize avg(p50), avg(p95), avg(p99) by bin(_time, 1h)",
            "usage": f"['{ds}'] | where _time > ago({timeframe}) | where event in ('tool.switch', 'feature.undo', 'feature.redo', 'feature.room_add') | summarize count() by event | sort by count_ desc",
        }
        if metric not in queries:
            raise ValueError(f"Unknown metric: {metric}. Choose from: {', '.join(queries)}")
        return self.query(queries[metric])
