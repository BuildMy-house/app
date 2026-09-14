"""axiom_usage — ships lightweight token-usage and tool-call metrics to Axiom.

Sibling to plugins/observability/langfuse: same register(ctx)/hook-name
contract, but ships compact usage records instead of full trace content.
Axiom is the cross-tool (Hermes + Claude Code + OpenCode) usage dashboard;
Langfuse, if ever enabled, remains the place for full trace/tool-call content.
Every hook body is failsafe — a broken network call must never interrupt an
actual Hermes turn.
"""
from __future__ import annotations

import json
import logging
import os
import queue
import threading
import time
import urllib.request
from typing import Any

logger = logging.getLogger(__name__)

_DATASET = "bmh-company"
# api.axiom.co routes to Axiom's default (us-east-1) region; this org's
# dataset lives in eu-central-1 and ingest requires that region's edge
# domain directly (confirmed live: GET /v1/datasets/bmh-company returned
# edgeDeploymentUrl: https://eu-central-1.aws.edge.axiom.co) — and that
# domain uses /v1/ingest/<dataset>, not /v1/datasets/<dataset>/ingest.
_ENDPOINT = f"https://eu-central-1.aws.edge.axiom.co/v1/ingest/{_DATASET}"
_FLUSH_INTERVAL = 5.0
_BATCH_MAX = 50

_queue: "queue.Queue[dict]" = queue.Queue()
_started = False
_start_lock = threading.Lock()


def _token() -> str:
    try:
        from agent.secret_scope import get_secret
        val = get_secret("AXIOM_TOKEN")
        if val:
            return val.strip()
    except Exception:
        pass
    return (os.environ.get("AXIOM_TOKEN") or "").strip()


def _push(event: dict[str, Any]) -> None:
    try:
        event.setdefault("_time", time.time())
        event.setdefault("service", "hermes-gateway")
        _queue.put_nowait(event)
    except Exception as exc:
        logger.debug("axiom_usage: enqueue failed: %s", exc)


def _flush_once() -> None:
    token = _token()
    if not token:
        return
    batch: list[dict] = []
    while len(batch) < _BATCH_MAX:
        try:
            batch.append(_queue.get_nowait())
        except queue.Empty:
            break
    if not batch:
        return
    try:
        body = json.dumps(batch).encode("utf-8")
        req = urllib.request.Request(_ENDPOINT, data=body, method="POST", headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        })
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as exc:
        logger.debug("axiom_usage: flush of %d events failed: %s", len(batch), exc)


def _flush_loop() -> None:
    while True:
        time.sleep(_FLUSH_INTERVAL)
        _flush_once()


def _ensure_started() -> None:
    global _started
    if _started:
        return
    with _start_lock:
        if _started:
            return
        threading.Thread(target=_flush_loop, name="axiom-usage-flush", daemon=True).start()
        _started = True


_CANONICAL_KEYS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens")


def _usage_from_canonical(canonical: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in _CANONICAL_KEYS:
        val = getattr(canonical, key, None)
        if val:
            out[key] = val
    return out


def _usage_from_response(response: Any, *, provider: str, api_mode: str) -> dict[str, Any]:
    # post_llm_call: a real provider SDK response object. Its raw .usage is
    # provider-specific (OpenAI/Anthropic/etc. all shape it differently) —
    # go through Hermes's own normalize_usage(), same as the langfuse
    # plugin, rather than guessing a schema ourselves.
    raw_usage = getattr(response, "usage", None)
    if not raw_usage:
        return {}
    try:
        from agent.usage_pricing import normalize_usage
        return _usage_from_canonical(normalize_usage(raw_usage, provider=provider, api_mode=api_mode))
    except Exception as exc:
        logger.debug("axiom_usage: normalize_usage failed: %s", exc)
        return {}


def _usage_from_dict(usage: dict) -> dict[str, Any]:
    # post_api_request: a pre-built CanonicalUsage summary dict (already
    # normalized by Hermes) — its keys are the canonical ones directly,
    # with a completion_tokens fallback for output_tokens.
    out: dict[str, Any] = {}
    input_tokens = usage.get("input_tokens", 0)
    output_tokens = usage.get("output_tokens", 0) or usage.get("completion_tokens", 0)
    cache_read = usage.get("cache_read_tokens", 0)
    cache_write = usage.get("cache_write_tokens", 0)
    reasoning = usage.get("reasoning_tokens", 0)
    if input_tokens:
        out["input_tokens"] = input_tokens
    if output_tokens:
        out["output_tokens"] = output_tokens
    if cache_read:
        out["cache_read_tokens"] = cache_read
    if cache_write:
        out["cache_write_tokens"] = cache_write
    if reasoning:
        out["reasoning_tokens"] = reasoning
    return out


def on_post_llm_call(*, task_id: str = "", session_id: str = "", turn_id: str = "", provider: str = "",
                     api_mode: str = "", model: str = "", response: Any = None, api_duration: float = 0.0,
                     usage: Any = None, response_model: Any = None, **_: Any) -> None:
    try:
        _ensure_started()
        resolved_model = response_model if isinstance(response_model, str) and response_model else model
        if getattr(response, "usage", None) is not None:
            usage_dict = _usage_from_response(response, provider=provider, api_mode=api_mode)
        elif isinstance(usage, dict) and usage:
            usage_dict = _usage_from_dict(usage)
        else:
            usage_dict = {}
        _push({
            "event": "llm_call", "task_id": task_id, "session_id": session_id, "turn_id": turn_id,
            "provider": provider, "model": resolved_model, "duration_ms": round((api_duration or 0.0) * 1000),
            **usage_dict,
        })
    except Exception as exc:
        logger.debug("axiom_usage: on_post_llm_call failed: %s", exc)


def on_post_tool_call(*, tool_name: str = "", task_id: str = "", session_id: str = "",
                      tool_call_id: str = "", turn_id: str = "", **_: Any) -> None:
    try:
        _ensure_started()
        _push({
            "event": "tool_call", "task_id": task_id, "session_id": session_id, "turn_id": turn_id,
            "tool_name": tool_name, "tool_call_id": tool_call_id,
        })
    except Exception as exc:
        logger.debug("axiom_usage: on_post_tool_call failed: %s", exc)


def register(ctx) -> None:
    # Both hook-name variants, same reasoning as the langfuse plugin: *_api_request
    # fires per API call (preferred); *_llm_call fires once per turn on older Hermes versions.
    hooks = (
        ("post_api_request", on_post_llm_call),
        ("post_llm_call", on_post_llm_call),
        ("post_tool_call", on_post_tool_call),
    )
    for name, fn in hooks:
        try:
            ctx.register_hook(name, fn)
        except Exception as exc:
            logger.debug("axiom_usage: failed to register hook %s: %s", name, exc)
