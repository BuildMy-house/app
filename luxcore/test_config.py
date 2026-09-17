"""Tests for luxcore.config (R7 — unified render configuration)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from .config import (
    CameraPreset,
    MaterialDefaults,
    QualityConfig,
    RenderConfig,
    RGBColor,
)

# ---------------------------------------------------------------------------
# Helper: minimal bridge scene dict for override tests
# ---------------------------------------------------------------------------

_BRIDGE_SCENE = {
    "materials": {
        "wall": {"type": "matte", "kd": [0.7, 0.7, 0.7]},
        "floor": {"type": "matte", "kd": [0.9, 0.9, 0.88]},
        "furniture": {"type": "matte", "kd": [0.6, 0.6, 0.75]},
    },
    "objects": [],
    "lights": [
        {"type": "directional", "name": "sun", "direction": [0, 0, -1], "gain": [3, 3, 3]},
        {"type": "constantinfinite", "name": "env", "color": [1, 1, 1], "gain": [1, 1, 1]},
        {"type": "point", "name": "portal_win1", "position": [1, 2, 1.5], "gain": [1500, 1500, 1500]},
        {"type": "point", "name": "lamp_l1", "position": [1, 2, 2.5], "gain": [2500, 2500, 2500]},
    ],
    "camera": {"lookat": [[0, 0, 5], [0, 0, 0], [0, 1, 0]], "fov": 60},
}


# ---------------------------------------------------------------------------
# Validation: invalid configs must be rejected
# ---------------------------------------------------------------------------

class TestInvalidConfigs:
    def test_unknown_material_type(self):
        with pytest.raises(ValidationError, match="material type"):
            MaterialDefaults(type="metalsmith")

    def test_kd_out_of_range(self):
        with pytest.raises(ValidationError):
            MaterialDefaults(kd=RGBColor(r=1.5, g=0, b=0))

    def test_roughness_below_minimum(self):
        with pytest.raises(ValidationError):
            MaterialDefaults(roughness=0.001)

    def test_unknown_light_type(self):
        with pytest.raises(ValidationError, match="light type"):
            from .config import LightPreset
            LightPreset(type="laser")

    def test_unknown_engine(self):
        with pytest.raises(ValidationError, match="engine"):
            QualityConfig(engine="VULKAN")

    def test_samples_out_of_range(self):
        with pytest.raises(ValidationError):
            QualityConfig(samples_per_pixel=9999)

    def test_width_zero(self):
        with pytest.raises(ValidationError):
            QualityConfig(width=0)

    def test_height_negative(self):
        with pytest.raises(ValidationError):
            QualityConfig(height=-10)

    def test_unknown_denoise_backend(self):
        with pytest.raises(ValidationError, match="denoise"):
            QualityConfig(denoise="temporal")

    def test_adaptive_strength_out_of_range(self):
        with pytest.raises(ValidationError):
            QualityConfig(adaptive_strength=0.2)

    def test_unknown_quality_preset(self):
        with pytest.raises(ValidationError, match="quality preset"):
            QualityConfig(preset="ultra-mega")

    def test_unknown_camera_preset(self):
        with pytest.raises(ValidationError, match="camera preset"):
            CameraPreset(use="warp-drive")

    def test_fov_too_large(self):
        with pytest.raises(ValidationError):
            CameraPreset(fov=200.0)

    def test_seconds_too_large(self):
        with pytest.raises(ValidationError):
            QualityConfig(seconds=9999)

    def test_noise_threshold_out_of_range(self):
        with pytest.raises(ValidationError):
            QualityConfig(noise_threshold=2.0)


# ---------------------------------------------------------------------------
# Validation: valid configs are accepted
# ---------------------------------------------------------------------------

class TestValidConfigs:
    def test_empty_config_uses_defaults(self):
        cfg = RenderConfig()
        assert cfg.materials.type == "matte"
        assert cfg.quality.engine == "PATHCPU"
        assert cfg.camera.use == "observer"
        assert cfg.lighting.sun.type == "directional"

    def test_glossy2_material(self):
        cfg = MaterialDefaults(type="glossy2", roughness=0.1)
        bridge = cfg.to_bridge()
        assert bridge["type"] == "glossy2"
        assert bridge["uroughness"] == 0.1
        assert bridge["vroughness"] == 0.1

    def test_quality_preset_valid(self):
        for name in ("cpu-preview", "cpu-final", "gpu-fast", "gpu-final"):
            cfg = QualityConfig(preset=name)
            assert cfg.preset == name

    def test_from_dict_round_trip(self):
        data = {
            "materials": {"type": "glossy2", "kd": {"r": 0.9, "g": 0.1, "b": 0.1}},
            "quality": {"samples_per_pixel": 128, "engine": "PATHCPU"},
        }
        cfg = RenderConfig.from_dict(data)
        assert cfg.materials.type == "glossy2"
        assert cfg.quality.samples_per_pixel == 128


# ---------------------------------------------------------------------------
# Scene override tests
# ---------------------------------------------------------------------------

class TestSceneOverrides:
    def test_material_overrides(self):
        cfg = RenderConfig.from_dict({
            "materials": {"type": "glossy2", "kd": {"r": 1.0, "g": 0.0, "b": 0.0}, "roughness": 0.3},
        })
        scene = cfg.apply_material_overrides(dict(_BRIDGE_SCENE))
        for name in ("wall", "floor", "furniture"):
            assert scene["materials"][name]["type"] == "glossy2"
            assert scene["materials"][name]["kd"] == [1.0, 0.0, 0.0]
            assert scene["materials"][name]["uroughness"] == 0.3

    def test_material_overrides_preserve_custom_materials(self):
        cfg = RenderConfig.from_dict({"materials": {"type": "glossy2"}})
        scene = dict(_BRIDGE_SCENE)
        scene["materials"]["custom_table"] = {"type": "matte", "kd": [0.5, 0.5, 0.5]}
        scene = cfg.apply_material_overrides(scene)
        assert scene["materials"]["custom_table"]["type"] == "matte"  # untouched

    def test_light_gain_overrides(self):
        cfg = RenderConfig.from_dict({
            "lighting": {
                "environment_gain": {"r": 2.0, "g": 2.0, "b": 2.0},
                "portal_gain": {"r": 0.5, "g": 0.5, "b": 0.5},
                "interior_gain": {"r": 3.0, "g": 3.0, "b": 3.0},
                "sun": {"type": "directional", "gain": {"r": 5.0, "g": 5.0, "b": 5.0}},
            },
        })
        scene = cfg.apply_light_overrides(dict(_BRIDGE_SCENE))
        sun = next(l for l in scene["lights"] if l["name"] == "sun")
        assert sun["gain"] == [5.0, 5.0, 5.0]
        env = next(l for l in scene["lights"] if l["name"] == "env")
        assert env["gain"] == [2.0, 2.0, 2.0]
        portal = next(l for l in scene["lights"] if l["name"] == "portal_win1")
        assert portal["gain"] == [0.5, 0.5, 0.5]
        lamp = next(l for l in scene["lights"] if l["name"] == "lamp_l1")
        assert lamp["gain"] == [3.0, 3.0, 3.0]


# ---------------------------------------------------------------------------
# to_render_settings
# ---------------------------------------------------------------------------

class TestToRenderSettings:
    def test_defaults_produce_valid_settings(self):
        from .renderer import validate_settings
        cfg = RenderConfig()
        rs = cfg.to_render_settings()
        validated = validate_settings(rs)
        assert validated.width == 800
        assert validated.samples_per_pixel == 256

    def test_custom_quality_maps_correctly(self):
        cfg = RenderConfig.from_dict({
            "quality": {"width": 1920, "height": 1080, "samples_per_pixel": 512,
                        "denoise": "oidn", "adaptive": True, "noise_threshold": 0.3},
        })
        rs = cfg.to_render_settings()
        assert rs.width == 1920
        assert rs.denoise.value == "INTEL_OIDN"
        assert rs.adaptive is True
        assert rs.noise_threshold == 0.3


# ---------------------------------------------------------------------------
# JSON Schema export
# ---------------------------------------------------------------------------

class TestJsonSchema:
    def test_schema_exports_valid_json(self):
        cfg = RenderConfig()
        schema = cfg.json_schema()
        assert schema["title"] == "RenderConfig"
        assert "materials" in schema["properties"]
        assert "quality" in schema["properties"]

    def test_schema_validates_example_file(self):
        import jsonschema
        example_path = Path(__file__).parent / "render-config-example.json"
        schema_path = Path(__file__).parent / "render-config.schema.json"
        if not example_path.exists() or not schema_path.exists():
            pytest.skip("example/schema files not present")
        schema = json.loads(schema_path.read_text())
        example = json.loads(example_path.read_text())
        jsonschema.validate(example, schema)


# ---------------------------------------------------------------------------
# End-to-end: config -> render (requires pyluxcore)
# ---------------------------------------------------------------------------

class TestEndToEndRender:
    def test_config_drives_render(self, tmp_path: Path):
        """Load example config, build a minimal scene, render, verify PNG output."""
        from .renderer import render
        cfg = RenderConfig.from_dict({
            "materials": {"type": "matte", "kd": {"r": 0.8, "g": 0.8, "b": 0.8}},
            "quality": {"width": 32, "height": 32, "samples_per_pixel": 4, "seconds": 5},
        })
        scene = cfg.apply_overrides(dict(_BRIDGE_SCENE))
        out = tmp_path / "test_render.png"
        png = render(scene, cfg.to_render_settings(), output_path=out)
        assert out.exists()
        assert out.stat().st_size > 0
        # PNG magic bytes
        assert png[:4] == b"\x89PNG"
