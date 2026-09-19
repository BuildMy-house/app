# LuxCore render and performance notes

## Fixed

- LuxCore asset lookup now resolves the Docker path (`/app/homely/assets/...`)
  and the local checkout path (`public/assets/...`).
- Render jobs pass the source home through to the worker, so normalized homes
  can resolve their real SH3D OBJ furniture instead of silently rendering boxes.
- OBJ, MTL, and asset-path lookups are cached during the worker lifetime.
- The Node queue retains at most 100 completed/failed jobs and removes their
  cached PNGs when evicted.
- Artifact downloads stream to disk instead of buffering the complete PNG and
  blocking the Node event loop with `writeFileSync`.
- Worker status polling backs off from 1s to 5s.
- Top-camera change detection fingerprints only bounds-relevant content instead
  of serializing unrelated home metadata.

## Known limits

- The render queue is still single-process and sequential; use a shared job
  store before running multiple API replicas.
- A render request built from a `RenderableScene` alone has no normalized home
  metadata, so its furniture remains box geometry. Send the normalized home in
  the `home` field for real SH3D assets.
- The `high` profile is intentionally expensive: 4096² at 4096 samples with a
  30-minute timeout. Keep it opt-in until real render timings justify a larger
  worker.

