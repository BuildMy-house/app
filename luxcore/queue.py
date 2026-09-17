"""In-memory render job queue with configurable concurrency.

Single-process, thread-pool based — right scale for a local/desktop or
small hosted deployment.  Not a distributed system.

Usage::

    queue = RenderQueue(max_workers=2)
    job = queue.submit(scene_data, settings)
    # ... later ...
    result = queue.result(job.id)  # raises if not done
"""
from __future__ import annotations

import enum
import secrets
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from .renderer import RenderSettings, render


class JobStatus(enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class RenderJob:
    id: str
    scene: dict[str, Any]
    settings: RenderSettings
    status: JobStatus = JobStatus.PENDING
    result_png: bytes | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.monotonic)
    started_at: float | None = None
    finished_at: float | None = None
    _future: Future | None = field(default=None, repr=False)


class RenderQueue:
    """Submit render jobs and retrieve results.  At most *max_workers*
    renders execute concurrently via a thread pool.

    *render_fn* defaults to ``renderer.render`` but can be swapped for
    testing.
    """

    def __init__(
        self,
        max_workers: int = 1,
        render_fn: Any = None,
    ):
        self._max_workers = max_workers
        self._render_fn = render_fn or render
        self._pool = ThreadPoolExecutor(max_workers=max_workers)
        self._jobs: dict[str, RenderJob] = {}
        self._lock = threading.Lock()

    # -- public API ----------------------------------------------------------

    def submit(
        self,
        scene: dict[str, Any],
        settings: RenderSettings | None = None,
    ) -> RenderJob:
        """Enqueue a render.  Returns the :class:`RenderJob` immediately."""
        settings = settings or RenderSettings()
        job_id = secrets.token_urlsafe(12)
        job = RenderJob(id=job_id, scene=scene, settings=settings)
        with self._lock:
            self._jobs[job_id] = job
        future = self._pool.submit(self._run, job)
        future.add_done_callback(lambda _f: None)  # prevent unhandled-exception warning
        job._future = future
        return job

    def status(self, job_id: str) -> JobStatus:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise KeyError(f"job {job_id!r} not found")
        return job.status

    def result(self, job_id: str) -> RenderJob:
        """Return the job.  Raises if not yet completed/failed."""
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise KeyError(f"job {job_id!r} not found")
        if job._future is not None:
            job._future.result()  # propagate exceptions, mark done
        return job

    def cancel(self, job_id: str) -> bool:
        """Cancel a pending job (running jobs cannot be interrupted)."""
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise KeyError(f"job {job_id!r} not found")
        if job.status == JobStatus.PENDING and job._future is not None:
            cancelled = job._future.cancel()
            if cancelled:
                with self._lock:
                    job.status = JobStatus.CANCELLED
                    job.finished_at = time.monotonic()
                return True
        return False

    def list_jobs(self) -> list[RenderJob]:
        with self._lock:
            return list(self._jobs.values())

    def shutdown(self, wait: bool = True) -> None:
        self._pool.shutdown(wait=wait)

    # -- internals -----------------------------------------------------------

    def _run(self, job: RenderJob) -> None:
        with self._lock:
            job.status = JobStatus.RUNNING
            job.started_at = time.monotonic()
        try:
            png = self._render_fn(job.scene, job.settings)
            with self._lock:
                job.result_png = png
                job.status = JobStatus.COMPLETED
                job.finished_at = time.monotonic()
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                job.error = str(exc)
                job.status = JobStatus.FAILED
                job.finished_at = time.monotonic()
