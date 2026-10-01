from __future__ import annotations

import json
import os
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class AxiomClient:
    """Minimal Axiom query client using only the Python standard library."""

    def __init__(self, token: str | None = None) -> None:
        self.token = token or os.environ.get("AXIOM_TOKEN", "")
        self.endpoint = (os.environ.get("AXIOM_ENDPOINT") or os.environ.get("AXIOM_URL", "")).rstrip("/")
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

    def ingest(self, events: list[dict]) -> None:
        """POST telemetry events to Axiom (same /v1/ingest route as the app's server and browser transports).

        Dataset-scoped ingest must target the dataset's edge deployment domain, so this resolves
        the same endpoint/token pair the browser ingest transport uses (VITE_AXIOM_ENDPOINT /
        VITE_AXIOM_TOKEN), with AXIOM_INGEST_ENDPOINT/AXIOM_INGEST_TOKEN as explicit overrides.
        """
        if not self.endpoint or not self.token:
            raise RuntimeError("Axiom is not configured: AXIOM_ENDPOINT/AXIOM_TOKEN must be set (no hardcoded fallback)")
        endpoint = (os.environ.get("AXIOM_INGEST_ENDPOINT") or os.environ.get("VITE_AXIOM_ENDPOINT") or self.endpoint).rstrip("/")
        token = os.environ.get("AXIOM_INGEST_TOKEN") or os.environ.get("VITE_AXIOM_TOKEN") or self.token
        request = Request(
            f"{endpoint}/v1/ingest/{self.dataset}",
            data=json.dumps(events).encode(),
            method="POST",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=10) as response:
                response.read()
        except HTTPError as exc:
            raise RuntimeError(f"Axiom ingest failed ({exc.code})") from exc

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
