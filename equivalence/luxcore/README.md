# LuxCore rendering

Install the optional renderer in the `equivalence` environment:

```sh
./luxcore/install.sh
python -m luxcore.renderer scene.json --asset-root ../homely/assets -o render.png \
  --width 800 --height 600 --samples 256
```

`scene.json` is a Homely exported project/state JSON. The CLI renders one
request into the requested output path and uses a private temporary directory;
it is safe to run separate worker processes for separate users. The stdin
protocol remains available to the equivalence adapter and accepts an optional
`{"scene": ..., "settings": ...}` envelope.

For a 2-core/4GB host, start with one worker, 640×480 and 32–64 samples for
previews. Limit final jobs to 4096×4096 and 4096 samples, and enforce an
external job timeout. Do not run untrusted scene JSON in the same process as
the web application.

## Reviewing a render

Build the included smoke scene with the CPU:

```sh
PYTHONPATH=. .venv/bin/python -m luxcore.renderer luxcore/smoke-scene.json \
  --output /tmp/luxcore-cpu.png --width 320 --height 240 --samples 4 --seconds 2
```

On an NVIDIA host, use `--engine PATHOCL`. The renderer calls `pyluxcore.Init()`
before device discovery; this is required for LuxCore to see CUDA/OpenCL GPUs.
The first GPU run may spend extra time compiling kernels, which are cached in
`~/.config/luxcorerender.org/cuda_kernel_cache/`.

Images are written to the path passed to `--output`, for example
`/tmp/luxcore-cpu.png`. The equivalence adapter returns the rendered PNG bytes
directly, so hosted jobs should persist the result in their job/artifact store.

The durable user library API can be started locally with:

```sh
python -m luxcore.asset_server --root var/assets --host 127.0.0.1 --port 8081
```

It stores each user under `var/assets/<user>/`, writes uploads atomically, and
keeps the previous manifest as `manifest.json.bak`. Put it behind the hosted
application’s authenticated reverse proxy; the route user id is only a storage
key, not an authentication mechanism.

The server also exposes the render job API. Submit with
`POST /api/render/jobs/<user>` and JSON `{ "scene": ..., "settings": ... }`.
Poll `GET /api/render/jobs/<user>/<job>` and fetch
`GET /api/render/jobs/<user>/<job>/artifact` when the status is `completed`.
The default is one worker, suitable for a 2-core/4GB host; authenticate these
routes at the reverse proxy.

The repository’s GLB assets are used by the browser renderer. LuxCore’s
Python API does not directly load GLB, so server renders load the original
high-resolution SH3D OBJ meshes instead. OBJ/MTL texture-material loading is
still the next quality step; never replace the source OBJ with the browser GLB.

The complete original Sweet Home 3D resource bundle is preserved at
`homely/assets/models/sh3d/`, including OBJ, MTL, and texture files. This is
the single source for model conversion and LuxCore asset resolution. Browser
GLBs are generated beside it in `homely/assets/models/`; no renderer-specific
asset copy is maintained.
