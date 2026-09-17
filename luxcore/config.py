"""Unified render configuration (R7).

One JSON file controls material defaults, lighting, camera, and render
quality so an autonomous agent or human can drive a render end-to-end
without knowing LuxCore property syntax.

Usage::

    from luxcore.config import load_config, RenderConfig

    config = RenderConfig.from_file("render-config.json")
    # or
    config = RenderConfig.from_dict({...})

    # Validate and apply to a scene:
    scene_data = config.apply_overrides(scene_data)

    # Get RenderSettings for the renderer:
    settings = config.to_render_settings()

Schema export::

    RenderConfig.model_json_schema()  # JSON Schema dict
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, field_validator

# ---------------------------------------------------------------------------
# Allowed enums — mirror the real LuxCore / renderer constraints
# ---------------------------------------------------------------------------

MATERIAL_TYPES = {"matte", "glossy2"}
LIGHT_TYPES = {"directional", "point", "constantinfinite"}
ENGINE_TYPES = {"PATHCPU", "PATHOCL"}
DENOISE_TYPES = {"none", "oidn", "bcd"}
CAMERA_PRESETS = {"top", "observer"}
PRESET_NAMES = {"cpu-preview", "cpu-final", "gpu-fast", "gpu-final"}


# ---------------------------------------------------------------------------
# Section models
# ---------------------------------------------------------------------------

class RGBColor(BaseModel):
    """RGB triplet.  Used for both colours (0-1) and gains (unbounded)."""
    r: float = Field(0.5, ge=0.0)
    g: float = Field(0.5, ge=0.0)
    b: float = Field(0.5, ge=0.0)

    def as_list(self) -> list[float]:
        return [self.r, self.g, self.b]

    @field_validator("r", "g", "b", mode="before")
    @classmethod
    def _round(cls, v: Any) -> float:
        return round(float(v), 4)


class MaterialDefaults(BaseModel):
    """Default material properties for wall/floor/furniture.

    These override the hard-coded defaults in bridge.py when the config
    is applied.
    """
    type: str = Field("matte", description="LuxCore material type: matte or glossy2")
    kd: RGBColor = Field(default_factory=RGBColor, description="Diffuse colour")
    ks: RGBColor = Field(default_factory=lambda: RGBColor(r=0.5, g=0.5, b=0.5),
                         description="Specular colour (glossy2 only)")
    roughness: float = Field(0.5, ge=0.02, le=1.0,
                             description="Surface roughness (glossy2 only, maps to uroughness/vroughness)")
    index: float = Field(1.5, ge=1.0, le=3.0,
                         description="IOR (glossy2 only)")

    @field_validator("type")
    @classmethod
    def _valid_type(cls, v: str) -> str:
        if v not in MATERIAL_TYPES:
            raise ValueError(f"unknown material type {v!r}; allowed: {sorted(MATERIAL_TYPES)}")
        return v

    @field_validator("kd", "ks")
    @classmethod
    def _valid_color(cls, v: RGBColor) -> RGBColor:
        for channel in (v.r, v.g, v.b):
            if channel > 1.0:
                raise ValueError(
                    f"material colour channel must be <= 1.0, got {channel}; "
                    "(kd/ks are reflectance colours, not light gains)"
                )
        return v

    def to_bridge(self) -> dict[str, Any]:
        """Convert to bridge.py material dict."""
        mat: dict[str, Any] = {"type": self.type, "kd": self.kd.as_list()}
        if self.type == "glossy2":
            mat["ks"] = self.ks.as_list()
            mat["uroughness"] = round(self.roughness, 4)
            mat["vroughness"] = round(self.roughness, 4)
            mat["index"] = self.index
        return mat


class LightPreset(BaseModel):
    """Sun/environment/interior light configuration."""
    type: str = Field("directional", description="directional | point | constantinfinite")
    name: str = Field("sun", description="Light name in the scene")
    gain: RGBColor = Field(default_factory=lambda: RGBColor(r=1.0, g=1.0, b=1.0),
                           description="Gain multiplier (RGB)")
    direction: list[float] | None = Field(
        default=None, description="[x, y, z] direction for directional lights (LuxCore Z-up)")
    color: RGBColor | None = Field(
        default=None, description="Colour for constantinfinite lights")

    @field_validator("type")
    @classmethod
    def _valid_type(cls, v: str) -> str:
        if v not in LIGHT_TYPES:
            raise ValueError(f"unknown light type {v!r}; allowed: {sorted(LIGHT_TYPES)}")
        return v

    def to_bridge(self) -> dict[str, Any]:
        """Convert to bridge.py light dict."""
        d: dict[str, Any] = {"type": self.type, "name": self.name,
                             "gain": self.gain.as_list()}
        if self.direction is not None:
            d["direction"] = self.direction
        if self.color is not None:
            d["color"] = self.color.as_list()
        return d


class LightingConfig(BaseModel):
    """Scene lighting controls.

    - ``environment_gain`` scales the constantinfinite sky light.
    - ``portal_gain`` scales point-light proxies at door/window openings.
    - ``interior_gain`` scales point lights from catalog light fixtures.
    - ``sun`` replaces the default directional sun light entirely.
    """
    environment_gain: RGBColor = Field(
        default_factory=lambda: RGBColor(r=1.0, g=1.0, b=1.0),
        description="Multiplier on the constantinfinite environment light")
    portal_gain: RGBColor = Field(
        default_factory=lambda: RGBColor(r=1.0, g=1.0, b=1.0),
        description="Gain for portal (door/window) point-light proxies")
    interior_gain: RGBColor = Field(
        default_factory=lambda: RGBColor(r=1.0, g=1.0, b=1.0),
        description="Gain for interior light-fixture point lights")
    sun: LightPreset = Field(
        default_factory=LightPreset,
        description="Override the default directional sun light")


class CameraPreset(BaseModel):
    """Camera selection or override.

    Set ``use`` to ``"top"`` or ``"observer"`` to pick a named camera from
    the home, or provide explicit ``lookat``/``fov`` for a custom camera.
    """
    use: str | None = Field("observer", description="Named camera preset: top | observer | null")
    lookat: list[list[float]] | None = Field(
        default=None, description="[[eye_x,y,z], [target_x,y,z], [up_x,y,z]] (metres, Z-up)")
    fov: float = Field(60.0, ge=5.0, le=179.0, description="Vertical field of view in degrees")

    @field_validator("use")
    @classmethod
    def _valid_preset(cls, v: str | None) -> str | None:
        if v is not None and v not in CAMERA_PRESETS:
            raise ValueError(f"unknown camera preset {v!r}; allowed: {sorted(CAMERA_PRESETS)}")
        return v


class QualityConfig(BaseModel):
    """Render quality / performance knobs.

    Maps directly to :class:`~luxcore.renderer.RenderSettings` fields.
    """
    preset: str | None = Field(None, description="Named preset: cpu-preview | cpu-final | gpu-fast | gpu-final")
    engine: str = Field("PATHCPU", description="Render engine: PATHCPU | PATHOCL")
    width: int = Field(800, ge=1, le=4096, description="Film width in pixels")
    height: int = Field(600, ge=1, le=4096, description="Film height in pixels")
    samples_per_pixel: int = Field(256, ge=1, le=4096, description="Max samples per pixel")
    seconds: int = Field(300, ge=1, le=1800, description="Render timeout in seconds")

    denoise: str = Field("none", description="Denoiser: none | oidn | bcd")
    denoise_sharpness: float = Field(0.1, ge=0.0, le=1.0, description="Denoise sharpness (0=full, 1=none)")
    denoise_oidn_memory_mb: int = Field(6000, ge=512, le=24000, description="OIDN GPU memory cap in MB")

    adaptive: bool = Field(False, description="Enable adaptive sampling")
    adaptive_warmup_spp: int = Field(32, ge=1, le=512, description="Adaptive warmup SPP")
    adaptive_step_spp: int = Field(32, ge=1, le=512, description="Adaptive step SPP")
    adaptive_strength: float = Field(0.7, ge=0.5, le=0.9, description="Sobol adaptive strength")
    noise_threshold: float = Field(0.5, ge=0.01, le=1.0, description="Noise halt threshold (lower = higher quality)")

    @field_validator("engine")
    @classmethod
    def _valid_engine(cls, v: str) -> str:
        if v not in ENGINE_TYPES:
            raise ValueError(f"unknown engine {v!r}; allowed: {sorted(ENGINE_TYPES)}")
        return v

    @field_validator("denoise")
    @classmethod
    def _valid_denoise(cls, v: str) -> str:
        if v not in DENOISE_TYPES:
            raise ValueError(f"unknown denoise backend {v!r}; allowed: {sorted(DENOISE_TYPES)}")
        return v

    @field_validator("preset")
    @classmethod
    def _valid_preset(cls, v: str | None) -> str | None:
        if v is not None and v not in PRESET_NAMES:
            raise ValueError(f"unknown quality preset {v!r}; allowed: {sorted(PRESET_NAMES)}")
        return v


# ---------------------------------------------------------------------------
# Top-level config
# ---------------------------------------------------------------------------

class RenderConfig(BaseModel):
    """Unified render configuration.

    Every section is optional — omitted sections use built-in defaults.
    """
    materials: MaterialDefaults = Field(default_factory=MaterialDefaults)
    lighting: LightingConfig = Field(default_factory=LightingConfig)
    camera: CameraPreset = Field(default_factory=CameraPreset)
    quality: QualityConfig = Field(default_factory=QualityConfig)

    # -- loaders -----------------------------------------------------------

    @classmethod
    def from_file(cls, path: str | Path) -> RenderConfig:
        """Load and validate a JSON config file."""
        import json as _json
        p = Path(path)
        if not p.is_file():
            raise FileNotFoundError(f"config file not found: {p}")
        return cls.model_validate(_json.loads(p.read_text()))

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> RenderConfig:
        """Validate a raw dict."""
        return cls.model_validate(data)

    # -- scene integration -------------------------------------------------

    def apply_material_overrides(self, scene_data: dict[str, Any]) -> dict[str, Any]:
        """Override default material definitions in a bridge scene dict.

        Materials named ``wall``, ``floor``, ``furniture`` are replaced
        with the config defaults.  Other materials are left untouched.
        """
        mats = scene_data.get("materials", {})
        bridge_mat = self.materials.to_bridge()
        for name in ("wall", "floor", "furniture"):
            if name in mats:
                mats[name] = dict(bridge_mat)
        scene_data["materials"] = mats
        return scene_data

    def apply_light_overrides(self, scene_data: dict[str, Any]) -> dict[str, Any]:
        """Override gain values on environment/portal/interior lights.

        Named lights ``env``, ``portal_*``, ``lamp_*`` have their gain
        replaced by the corresponding config section.  The sun light is
        fully replaced by ``self.lighting.sun``.
        """
        env_gain = self.lighting.environment_gain.as_list()
        portal_gain = self.lighting.portal_gain.as_list()
        interior_gain = self.lighting.interior_gain.as_list()
        sun_bridge = self.lighting.sun.to_bridge()

        new_lights: list[dict] = []
        for light in scene_data.get("lights", []):
            name = light.get("name", "")
            if name == "sun":
                new_lights.append(sun_bridge)
            elif name == "env":
                light["gain"] = list(env_gain)
                new_lights.append(light)
            elif name.startswith("portal_"):
                light["gain"] = list(portal_gain)
                new_lights.append(light)
            elif name.startswith("lamp_"):
                light["gain"] = list(interior_gain)
                new_lights.append(light)
            else:
                new_lights.append(light)
        scene_data["lights"] = new_lights
        return scene_data

    def apply_overrides(self, scene_data: dict[str, Any]) -> dict[str, Any]:
        """Apply all config overrides to a bridge scene dict."""
        scene_data = self.apply_material_overrides(scene_data)
        scene_data = self.apply_light_overrides(scene_data)
        return scene_data

    def to_render_settings(self) -> Any:
        """Build a :class:`~luxcore.renderer.RenderSettings` from this config."""
        from .renderer import DenoiseBackend, RenderSettings

        denoise_map = {"none": DenoiseBackend.NONE, "oidn": DenoiseBackend.OIDN,
                       "bcd": DenoiseBackend.BCD}
        return RenderSettings(
            preset=self.quality.preset,
            engine=self.quality.engine,
            width=self.quality.width,
            height=self.quality.height,
            samples_per_pixel=self.quality.samples_per_pixel,
            seconds=self.quality.seconds,
            denoise=denoise_map[self.quality.denoise],
            denoise_sharpness=self.quality.denoise_sharpness,
            denoise_oidn_memory_mb=self.quality.denoise_oidn_memory_mb,
            adaptive=self.quality.adaptive,
            adaptive_warmup_spp=self.quality.adaptive_warmup_spp,
            adaptive_step_spp=self.quality.adaptive_step_spp,
            adaptive_strength=self.quality.adaptive_strength,
            noise_threshold=self.quality.noise_threshold,
        )

    # -- schema export -----------------------------------------------------

    def json_schema(self) -> dict[str, Any]:
        """Return a JSON Schema (2020-12) for this config format."""
        return self.model_json_schema()
