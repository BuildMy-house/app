"""LuxCore render settings, denoising, adaptive sampling, presets, and job queue.

Denoising uses LuxCore's image pipeline plugin API (verified against
pyluxcore 2.11 / SDL Reference Manual v2.11):
  film.imagepipelines.<pipeline>.<plugin>.type = "INTEL_OIDN" | "BCD_DENOISER"
  film.imagepipelines.<pipeline>.<plugin>.sharpness = <float>

Adaptive sampling uses noise estimation:
  film.noiseestimation.warmup = <int>
  film.noiseestimation.step = <int>
  sampler.sobol.adaptive.strength = <float>   (0.5..0.9)
  batch.haltnoisethreshold = <float>          (-1.0 disables)
  batch.haltnoisethreshold.stoprendering.enable = 0|1

Presets bundle engine + resolution + samples + denoise + adaptive sensibly.
"""
from __future__ import annotations

import argparse
import base64
import dataclasses
import enum
import json
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .bridge import build_scene, home_to_scene, renderable_scene_to_lux


class DenoiseBackend(enum.Enum):
    """Denoiser backends supported by LuxCore's film image pipeline."""

    NONE = "none"
    OIDN = "INTEL_OIDN"
    BCD = "BCD_DENOISER"


@dataclass(frozen=True)
class RenderSettings:
    width: int = 800
    height: int = 600
    samples_per_pixel: int = 256
    seconds: int = 300
    engine: str = "PATHCPU"
    poll_seconds: float = 0.1
    # --- denoising (verified: film.imagepipelines plugin API) ---
    denoise: DenoiseBackend = DenoiseBackend.NONE
    denoise_sharpness: float = 0.1  # 0.0 = full denoise, 1.0 = no denoise
    denoise_oidn_memory_mb: int = 6000  # max GPU memory for OIDN
    # --- adaptive sampling (verified: noiseestimation + haltnoisethreshold) ---
    adaptive: bool = False
    adaptive_warmup_spp: int = 32  # avg SPP before convergence test
    adaptive_step_spp: int = 32  # avg SPP between convergence tests
    adaptive_strength: float = 0.7  # sampler.sobol.adaptive.strength (0.5..0.9)
    noise_threshold: float = 0.5  # batch.haltnoisethreshold; lower = higher quality
    # --- preset (resolved into the above fields) ---
    preset: str | None = None  # e.g. "cpu-preview", "gpu-fast", "gpu-final"


# ---------------------------------------------------------------------------
# Named presets — bundle engine + resolution + samples + denoise + adaptive
# ---------------------------------------------------------------------------
# README guidance: "2-core/4GB host: 1 worker, 640×480, 32–64 spp for previews.
# Final jobs: 4096×4096, 4096 spp."
PRESETS: dict[str, dict[str, Any]] = {
    "cpu-preview": {
        "engine": "PATHCPU",
        "width": 640,
        "height": 480,
        "samples_per_pixel": 64,
        "seconds": 60,
        "denoise": DenoiseBackend.NONE,
        "adaptive": True,
        "noise_threshold": 0.8,
        "description": "Fast CPU preview — low res, few samples, adaptive halting",
    },
    "cpu-final": {
        "engine": "PATHCPU",
        "width": 1920,
        "height": 1080,
        "samples_per_pixel": 512,
        "seconds": 600,
        "denoise": DenoiseBackend.OIDN,
        "adaptive": True,
        "noise_threshold": 0.3,
        "description": "High-quality CPU final — denoised, adaptive, 10 min budget",
    },
    "gpu-fast": {
        "engine": "PATHOCL",
        "width": 800,
        "height": 600,
        "samples_per_pixel": 128,
        "seconds": 120,
        "denoise": DenoiseBackend.OIDN,
        "adaptive": True,
        "noise_threshold": 0.5,
        "description": "Fast GPU preview — OpenCL + OIDN denoising",
    },
    "gpu-final": {
        "engine": "PATHOCL",
        "width": 4096,
        "height": 4096,
        "samples_per_pixel": 4096,
        "seconds": 1800,
        "denoise": DenoiseBackend.OIDN,
        "adaptive": True,
        "noise_threshold": 0.2,
        "description": "Maximum GPU quality — 4K, full samples, OIDN, 30 min budget",
    },
}


def resolve_preset(settings: RenderSettings) -> RenderSettings:
    """If settings.preset is set, overlay preset defaults (explicit fields win)."""
    if settings.preset is None:
        return settings
    preset = PRESETS.get(settings.preset)
    if preset is None:
        raise ValueError(
            f"unknown preset {settings.preset!r}; available: {', '.join(sorted(PRESETS))}"
        )
    # Build a dict from settings, then overlay preset values only for fields
    # that were NOT explicitly provided (i.e., still at their dataclass default).
    defaults = {f.name: f.default for f in dataclasses.fields(RenderSettings) if f.name != "preset"}
    current = dataclasses.asdict(settings)
    merged = {}
    for key, default in defaults.items():
        if current[key] == default and key in preset:
            merged[key] = preset[key]
        else:
            merged[key] = current[key]
    merged["preset"] = settings.preset
    # Reconstruct with proper types for enum fields
    merged["denoise"] = (
        DenoiseBackend(merged["denoise"])
        if isinstance(merged["denoise"], str)
        else merged["denoise"]
    )
    return RenderSettings(**merged)


def validate_settings(settings: RenderSettings) -> RenderSettings:
    if isinstance(settings.denoise, str):
        try:
            settings = dataclasses.replace(settings, denoise=DenoiseBackend(settings.denoise))
        except ValueError as exc:
            raise ValueError(f"unknown denoise backend: {settings.denoise}") from exc
    settings = resolve_preset(settings)
    if not 1 <= settings.width <= 4096 or not 1 <= settings.height <= 4096:
        raise ValueError("width and height must be between 1 and 4096")
    if not 1 <= settings.samples_per_pixel <= 4096:
        raise ValueError("samples_per_pixel must be between 1 and 4096")
    if settings.engine not in {"PATHCPU", "PATHOCL"}:
        raise ValueError("engine must be PATHCPU or PATHOCL")
    if not 1 <= settings.seconds <= 1800:
        raise ValueError("seconds must be between 1 and 1800")
    if not 0.01 <= settings.poll_seconds <= 2:
        raise ValueError("poll_seconds must be between 0.01 and 2")
    if settings.denoise not in DenoiseBackend:
        raise ValueError(f"denoise must be one of {[d.value for d in DenoiseBackend]}")
    if not 0.0 <= settings.denoise_sharpness <= 1.0:
        raise ValueError("denoise_sharpness must be between 0.0 and 1.0")
    if not 0.5 <= settings.adaptive_strength <= 0.9:
        raise ValueError("adaptive_strength must be between 0.5 and 0.9")
    return settings


# ---------------------------------------------------------------------------
# Film property builders (verified against LuxCore 2.11 API)
# ---------------------------------------------------------------------------

def _build_image_pipeline_props(settings: RenderSettings) -> str:
    """Build film.imagepipelines properties — tonemap + optional denoise + gamma.

    Tonemapping and gamma correction are ALWAYS applied (unconditionally),
    so that RGB_TONEMAPPED output is correctly toned even without denoising.
    The denoiser plugin is inserted into the pipeline only when requested.

    Pipeline order (LuxCore 2.11 SDL Reference Manual):
      tonemap → [denoiser] → gamma correction

    Tonemap default: TONEMAP_REINHARD02 — automatic photographic operator,
    no hand-tuned scale needed. Works well for previews and finals alike.

    Verified property keys:
      film.imagepipelines.<pipeline>.<plugin>.type
      film.imagepipelines.<pipeline>.<plugin>.sharpness   (denoiser)
      film.imagepipelines.<pipeline>.<plugin>.oidnmemory  (OIDN only)
      film.imagepipelines.<pipeline>.<plugin>.value       (GAMMA_CORRECTION)
    """
    # Slot 0: tonemap (always present)
    lines = ["film.imagepipelines.0.0.type = TONEMAP_REINHARD02"]
    next_slot = 1

    # Slot 1 (when denoising): denoiser plugin
    if settings.denoise != DenoiseBackend.NONE:
        lines.append(f"film.imagepipelines.0.{next_slot}.type = {settings.denoise.value}")
        lines.append(f"film.imagepipelines.0.{next_slot}.sharpness = {settings.denoise_sharpness}")
        if settings.denoise == DenoiseBackend.OIDN:
            lines.append(
                f"film.imagepipelines.0.{next_slot}.oidnmemory = {settings.denoise_oidn_memory_mb}"
            )
        next_slot += 1

    # Last slot: gamma correction (always present)
    lines.append(f"film.imagepipelines.0.{next_slot}.type = GAMMA_CORRECTION")
    lines.append(f"film.imagepipelines.0.{next_slot}.value = 2.2")

    # Route RGB output through this pipeline
    lines.append("film.imagepipeline.0.type = RGB_IMAGEPIPELINE")
    lines.append("film.imagepipeline.0.index = 0")
    return "\n".join(lines)


def _build_adaptive_props(settings: RenderSettings) -> str:
    """Build noise estimation and adaptive halting properties.

    Verified property keys (LuxCore 2.11):
      film.noiseestimation.warmup = <int>
      film.noiseestimation.step = <int>
      sampler.sobol.adaptive.strength = <float>
      batch.haltnoisethreshold = <float>        (-1.0 disables)
      batch.haltnoisethreshold.stoprendering.enable = 0|1
    """
    if not settings.adaptive:
        return ""
    lines = [
        f"film.noiseestimation.warmup = {settings.adaptive_warmup_spp}",
        f"film.noiseestimation.step = {settings.adaptive_step_spp}",
        f"sampler.sobol.adaptive.strength = {settings.adaptive_strength}",
        f"batch.haltnoisethreshold = {settings.noise_threshold}",
        "batch.haltnoisethreshold.stoprendering.enable = 1",
        f"batch.haltnoisethreshold.warmup = {settings.adaptive_warmup_spp}",
        f"batch.haltnoisethreshold.step = {settings.adaptive_step_spp}",
    ]
    return "\n".join(lines)


def render(
    scene_data: dict,
    settings: RenderSettings | None = None,
    output_path: str | Path | None = None,
    home: dict | None = None,
) -> bytes:
    import pyluxcore

    settings = validate_settings(settings or RenderSettings())
    if settings.engine == "PATHOCL":
        pyluxcore.Init()
    if settings.engine == "PATHOCL" and not pyluxcore.GetOpenCLDeviceList():
        raise RuntimeError(
            "PATHOCL requested, but LuxCore sees no OpenCL devices; "
            "expose the host GPU and NVIDIA OpenCL ICD to this process"
        )
    with tempfile.TemporaryDirectory(prefix="luxcore-render-") as work:
        prefix = Path(work) / "image"
        # Core film + engine config
        config_str = (
            f"renderengine.type = {settings.engine}\n"
            f"film.width = {settings.width}\n"
            f"film.height = {settings.height}\n"
            f"film.samplesperpixel = {settings.samples_per_pixel}\n"
            f"film.gamma = 2.2\n"
            f"batch.haltspp = {settings.samples_per_pixel}\n"
            f"sampler.type = SOBOL"
        )
        # Image pipeline (tonemap + optional denoise + gamma — always applied)
        pipeline_str = _build_image_pipeline_props(settings)
        config_str += "\n" + pipeline_str
        # Adaptive sampling
        adaptive_str = _build_adaptive_props(settings)
        if adaptive_str:
            config_str += "\n" + adaptive_str

        config = pyluxcore.Properties()
        config.SetFromString(config_str)
        if "version" in scene_data:
            # TS RenderableScene: prefer the renderable-scene path; `home` is
            # optional and enables real-OBJ furniture resolution.
            scene = renderable_scene_to_lux(scene_data, pyluxcore, home)
        elif "walls" in scene_data:
            # Legacy normalized-home path (Track C differential harness).
            scene = build_scene(home_to_scene(scene_data), pyluxcore)
        else:
            # Already-built ad-hoc bridge scene.
            scene = build_scene(scene_data, pyluxcore)
        session = pyluxcore.RenderSession(pyluxcore.RenderConfig(config, scene))
        session.Start()
        deadline = time.monotonic() + settings.seconds
        try:
            while not session.HasDone():
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"render exceeded {settings.seconds}s timeout")
                time.sleep(settings.poll_seconds)
                session.UpdateStats()
        finally:
            session.Stop()
        session.GetFilm().SaveOutput(
            str(prefix) + ".png",
            pyluxcore.FilmOutputType.RGB_TONEMAPPED,
            pyluxcore.Properties(),
        )
        data = prefix.with_suffix(".png").read_bytes()
    if output_path:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_bytes(data)
    return data


def stream_main() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            settings = RenderSettings(**request.get("settings", {}))
            print(
                base64.b64encode(
                    render(
                        request.get("scene", request),
                        settings,
                        home=request.get("home"),
                    )
                ).decode(),
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"error": str(exc)}), file=sys.stderr, flush=True)
            return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("-o", "--output", type=Path, required=True)
    parser.add_argument("--width", type=int, default=800)
    parser.add_argument("--height", type=int, default=600)
    parser.add_argument("--samples", type=int, default=256)
    parser.add_argument("--engine", choices=["PATHCPU", "PATHOCL"], default="PATHCPU")
    parser.add_argument("--seconds", type=int, default=300)
    parser.add_argument("--preset", choices=list(PRESETS), default=None)
    parser.add_argument("--denoise", choices=["none", "oidn", "bcd"], default="none")
    parser.add_argument("--adaptive", action="store_true")
    args = parser.parse_args()
    denoise_map = {"none": DenoiseBackend.NONE, "oidn": DenoiseBackend.OIDN, "bcd": DenoiseBackend.BCD}
    data = json.loads(args.input.read_text())
    render(
        data,
        RenderSettings(
            width=args.width,
            height=args.height,
            samples_per_pixel=args.samples,
            engine=args.engine,
            seconds=args.seconds,
            preset=args.preset,
            denoise=denoise_map[args.denoise],
            adaptive=args.adaptive,
        ),
        args.output,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(stream_main() if len(sys.argv) == 1 else main())
