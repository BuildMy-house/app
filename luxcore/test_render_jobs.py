import threading
import time
from pathlib import Path

import pytest

from luxcore.queue import JobStatus, RenderJob, RenderQueue
from luxcore.renderer import DenoiseBackend, RenderSettings


def test_render_job_lifecycle_and_user_isolation(tmp_path: Path, monkeypatch):
    """Existing test — render_jobs.py RenderJobStore."""
    from luxcore.render_jobs import RenderJobStore

    store = RenderJobStore(tmp_path)
    calls = []

    def fake_render(scene, settings, output):
        calls.append((scene, settings))
        Path(output).write_bytes(b"png")
        return b"png"

    monkeypatch.setattr("luxcore.render_jobs.render", fake_render)
    created = store.create("user-1", {"objects": []}, {"seconds": 4})
    assert created["status"] == "queued"
    finished = store.run("user-1", created["id"])
    assert finished["status"] == "completed"
    assert store.artifact("user-1", created["id"]) == b"png"
    assert calls[0][1].seconds == 4


def test_queue_submit_and_complete():
    """Submit a job with a fake renderer, verify it completes."""
    results = []

    def fake_render(scene, settings):
        results.append((scene, settings))
        return b"fake-png-bytes"

    q = RenderQueue(max_workers=2, render_fn=fake_render)
    try:
        job = q.submit({"walls": []}, RenderSettings(seconds=1))
        assert job.status in (JobStatus.PENDING, JobStatus.RUNNING, JobStatus.COMPLETED)
        finished = q.result(job.id)
        assert finished.status == JobStatus.COMPLETED
        assert finished.result_png == b"fake-png-bytes"
        assert len(results) == 1
    finally:
        q.shutdown()


def test_queue_concurrent_execution():
    """Two jobs should run concurrently with max_workers=2."""
    barrier = threading.Barrier(2, timeout=5)

    def slow_render(scene, settings):
        barrier.wait()  # blocks until both threads reach here
        return b"png"

    q = RenderQueue(max_workers=2, render_fn=slow_render)
    try:
        j1 = q.submit({})
        j2 = q.submit({})
        r1 = q.result(j1.id)
        r2 = q.result(j2.id)
        assert r1.status == JobStatus.COMPLETED
        assert r2.status == JobStatus.COMPLETED
    finally:
        q.shutdown()


def test_queue_serial_execution():
    """With max_workers=1, jobs run sequentially."""
    order = []
    lock = threading.Lock()

    def tracking_render(scene, settings):
        with lock:
            order.append(scene.get("tag"))
        time.sleep(0.05)
        return b"png"

    q = RenderQueue(max_workers=1, render_fn=tracking_render)
    try:
        j1 = q.submit({"tag": "first"})
        j2 = q.submit({"tag": "second"})
        q.result(j1.id)
        q.result(j2.id)
        assert order == ["first", "second"]
    finally:
        q.shutdown()


def test_queue_failed_job():
    def failing_render(scene, settings):
        raise RuntimeError("render exploded")

    q = RenderQueue(render_fn=failing_render)
    try:
        job = q.submit({})
        result = q.result(job.id)
        assert result.status == JobStatus.FAILED
        assert "render exploded" in result.error
    finally:
        q.shutdown()


def test_queue_status_lookup():
    q = RenderQueue(render_fn=lambda s, st: b"png")
    try:
        job = q.submit({})
        assert q.status(job.id) in (JobStatus.PENDING, JobStatus.RUNNING, JobStatus.COMPLETED)
        with pytest.raises(KeyError):
            q.status("nonexistent-id")
    finally:
        q.shutdown()


def test_queue_list_jobs():
    q = RenderQueue(render_fn=lambda s, st: b"png")
    try:
        j1 = q.submit({})
        j2 = q.submit({})
        jobs = q.list_jobs()
        ids = {j.id for j in jobs}
        assert j1.id in ids
        assert j2.id in ids
    finally:
        q.shutdown()


def test_queue_submit_with_settings():
    captured = []

    def fake_render(scene, settings):
        captured.append(settings)
        return b"png"

    q = RenderQueue(render_fn=fake_render)
    try:
        settings = RenderSettings(
            width=1024,
            height=768,
            samples_per_pixel=128,
            denoise=DenoiseBackend.OIDN,
            adaptive=True,
        )
        q.submit({}, settings)
        q.result(q.list_jobs()[0].id)
        assert captured[0].width == 1024
        assert captured[0].denoise is DenoiseBackend.OIDN
        assert captured[0].adaptive is True
    finally:
        q.shutdown()


def test_render_job_dataclass_fields():
    job = RenderJob(id="test-123", scene={}, settings=RenderSettings())
    assert job.id == "test-123"
    assert job.status == JobStatus.PENDING
    assert job.result_png is None
    assert job.error is None
    assert job.created_at > 0
