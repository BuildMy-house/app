import json
from pathlib import Path

import pytest

from luxcore.bridge import (
    _load_obj,
    _polygon_to_mesh,
    home_to_scene,
    renderable_to_bridge,
)
from luxcore.renderer import (
    PRESETS,
    DenoiseBackend,
    RenderSettings,
    _build_image_pipeline_props,
    resolve_preset,
    validate_settings,
)


def test_render_settings_are_bounded():
    assert validate_settings(RenderSettings(800, 600, 32)).samples_per_pixel == 32
    with pytest.raises(ValueError):
        validate_settings(RenderSettings(5000, 600, 32))
    with pytest.raises(ValueError):
        validate_settings(RenderSettings(800, 600, 0))
    with pytest.raises(ValueError):
        validate_settings(RenderSettings(800, 600, 32, poll_seconds=0))


def test_home_export_maps_to_scene_without_mutating_input(tmp_path: Path):
    home = {
        "walls": [
            {"id": "wall-1", "xStart": 0, "yStart": 0, "xEnd": 400, "yEnd": 0, "height": 250}
        ],
        "rooms": [],
        "furniture": [],
        "cameras": {"top": {"x": 0, "y": 0, "z": 1000}},
    }
    before = json.dumps(home, sort_keys=True)
    scene = home_to_scene(home, tmp_path)
    assert len(scene["objects"]) == 1
    assert scene["objects"][0]["size"][2] == 2.5
    assert json.dumps(home, sort_keys=True) == before


def test_flat_polygon_has_non_degenerate_faces():
    vertices, faces = _polygon_to_mesh([[0, 0], [4, 0], [4, 3], [0, 3]], 0, 0)
    assert len(vertices) == 12
    assert faces == [0, 1, 2, 0, 2, 3]


def test_home_resolves_original_sh3d_mesh():
    home = {
        "walls": [],
        "rooms": [],
        "furniture": [
            {"id": "sofa", "catalogId": "eTeks#sofa", "width": 190, "depth": 85, "height": 87}
        ],
        "cameras": {},
    }
    asset = home_to_scene(home)["objects"][0]
    vertices, faces = _load_obj(asset["path"], asset["size"], asset["position"], asset["rotation"])
    assert asset["type"] == "asset"
    assert len(vertices) > 1000 and len(faces) > 1000
    assert min(vertex[2] for vertex in vertices) == pytest.approx(0)
    assert max(vertex[2] for vertex in vertices) > 0.5


# --- denoising / adaptive / preset tests ---


def test_denoise_backend_enum():
    assert DenoiseBackend.NONE.value == "none"
    assert DenoiseBackend.OIDN.value == "INTEL_OIDN"
    assert DenoiseBackend.BCD.value == "BCD_DENOISER"


def test_denoise_settings_validation():
    s = RenderSettings(denoise=DenoiseBackend.OIDN, denoise_sharpness=0.3)
    validated = validate_settings(s)
    assert validated.denoise == DenoiseBackend.OIDN
    assert validated.denoise_sharpness == 0.3

    with pytest.raises(ValueError, match="sharpness"):
        validate_settings(RenderSettings(denoise_sharpness=1.5))


def test_adaptive_settings_validation():
    s = RenderSettings(adaptive=True, adaptive_strength=0.8, noise_threshold=0.3)
    validated = validate_settings(s)
    assert validated.adaptive is True
    assert validated.adaptive_strength == 0.8

    with pytest.raises(ValueError, match="strength"):
        validate_settings(RenderSettings(adaptive_strength=0.1))


def test_presets_exist():
    assert "cpu-preview" in PRESETS
    assert "cpu-final" in PRESETS
    assert "gpu-fast" in PRESETS
    assert "gpu-final" in PRESETS


def test_resolve_preset_overlays_defaults():
    s = RenderSettings(preset="cpu-preview")
    resolved = resolve_preset(s)
    assert resolved.engine == "PATHCPU"
    assert resolved.width == 640
    assert resolved.height == 480
    assert resolved.samples_per_pixel == 64
    assert resolved.adaptive is True
    assert resolved.denoise == DenoiseBackend.NONE


def test_resolve_preset_explicit_fields_win():
    s = RenderSettings(preset="gpu-fast", width=1024, height=768)
    resolved = resolve_preset(s)
    assert resolved.width == 1024  # explicit, not from preset
    assert resolved.height == 768  # explicit, not from preset
    assert resolved.engine == "PATHOCL"  # from preset


def test_resolve_preset_unknown_raises():
    with pytest.raises(ValueError, match="unknown preset"):
        resolve_preset(RenderSettings(preset="nonexistent"))


def test_validate_settings_with_preset():
    s = RenderSettings(preset="gpu-final")
    validated = validate_settings(s)
    assert validated.engine == "PATHOCL"
    assert validated.width == 4096
    assert validated.samples_per_pixel == 4096
    assert validated.denoise == DenoiseBackend.OIDN


def test_render_settings_frozen():
    s = RenderSettings()
    with pytest.raises(AttributeError):
        s.width = 999  # type: ignore[misc]


def test_render_settings_defaults():
    s = RenderSettings()
    assert s.denoise == DenoiseBackend.NONE
    assert s.adaptive is False
    assert s.preset is None
    assert s.noise_threshold == 0.5


# --- RenderableScene (TS scene-builder JSON) consumption ---


def _rs_scene(wall_boxes: int) -> dict:
    """A minimal RenderableScene with one wall split into `wall_boxes` boxes.

    Mirrors buildWallPrimitives output: each box is Y-up/centred, [w,h,d] cm.
    """
    prims = []
    for i in range(wall_boxes):
        prims.append({"type": "box", "position": [200, 125, 0], "size": [400, 250, 15],
                      "rotation": [0, 0, 0], "materialId": "mat_wall"})
    return {
        "version": 1,
        "name": "wall",
        "textures": [],
        "materials": [{"id": "mat_wall", "color": 0xD2D2D2, "shininess": 0,
                       "opacity": 1, "model": "standard"}],
        "objects": [{"id": "wall:w1", "name": "Wall w1", "primitives": prims,
                     "visible": {"plan": True, "threeD": True, "luxcore": True}}],
        "camera": {"position": [300, 150, 200], "yaw": 3.141592653589793,
                   "pitch": -0.2617993877991494, "fov": 58, "projection": "perspective"},
        "lights": [],
        "backgroundColor": 0,
    }


def test_renderable_scene_emits_one_box_per_wall_primitive():
    # Plain wall -> 2 boxes (left+right face); windowed wall -> 8 boxes
    # (the TS scene-builder DoD counts). Each box primitive must become one
    # LuxCore geometry segment.
    plain = renderable_to_bridge(_rs_scene(2))
    windowed = renderable_to_bridge(_rs_scene(8))
    assert len(plain["objects"]) == 2
    assert len(windowed["objects"]) == 8
    assert all(o["type"] == "box" for o in windowed["objects"])
    # Every segment maps Y-up cm to Z-up m, bottom-anchored in height.
    for o in windowed["objects"]:
        assert o["size"] == [4.0, 0.15, 2.5]
        assert o["position"] == [2.0, 0.0, 0.0]


def test_renderable_wall_box_matches_home_to_scene():
    home = {"walls": [{"id": "w1", "xStart": 0, "yStart": 0, "xEnd": 400, "yEnd": 0,
                       "thickness": 15, "height": 250}],
            "rooms": [], "furniture": [], "cameras": {}}
    bridge = renderable_to_bridge(_rs_scene(2))
    legacy = home_to_scene(home)["objects"][0]
    # Size, position, and Z-up rotation must agree with the legacy path.
    assert bridge["objects"][0]["size"] == legacy["size"]
    assert bridge["objects"][0]["position"] == legacy["position"]
    assert bridge["objects"][0]["rotation"] == legacy["rotation"]


def test_renderable_camera_matches_observer_camera():
    home = {"walls": [], "rooms": [], "furniture": [],
            "cameras": {"observer": {"x": 300, "y": 200, "z": 150,
                                     "yawDeg": 0, "pitchDeg": 15, "fovDeg": 58}}}
    rs = _rs_scene(2)
    rs["camera"] = {"position": [300, 150, 200], "yaw": 3.141592653589793,
                    "pitch": -0.2617993877991494, "fov": 58, "projection": "perspective"}
    rs_cam = renderable_to_bridge(rs)["camera"]
    legacy_cam = home_to_scene(home)["camera"]
    assert rs_cam["lookat"][0] == pytest.approx(legacy_cam["lookat"][0])
    assert rs_cam["lookat"][1] == pytest.approx(legacy_cam["lookat"][1])
    assert rs_cam["lookat"][2] == pytest.approx(legacy_cam["lookat"][2])
    assert rs_cam["fov"] == pytest.approx(legacy_cam["fov"])


def test_renderable_furniture_resolves_original_sh3d_mesh():
    # Furniture override: a furniture:<id> object whose home item has a
    # catalogId resolves to the real OBJ asset, not a box.
    home = {"furniture": [{"id": "sofa", "catalogId": "eTeks#sofa",
                           "width": 220, "depth": 85, "height": 85,
                           "x": 170, "y": 210, "angleDeg": 0, "elevation": 0}]}
    rs = _rs_scene(2)
    rs["objects"] = [{"id": "furniture:sofa", "name": "Sofa",
                      "primitives": [{"type": "box", "position": [170, 42.5, 210],
                                      "size": [220, 85, 85], "rotation": [0, 0, 0],
                                      "materialId": "mat_furn"}],
                      "visible": {"plan": True, "threeD": True, "luxcore": True}}]
    bridged = renderable_to_bridge(rs, home)
    asset = bridged["objects"][0]
    assert asset["type"] == "asset"
    vertices, faces = _load_obj(asset["path"], asset["size"], asset["position"], asset["rotation"])
    assert len(vertices) > 1000 and len(faces) > 1000
    assert min(vertex[2] for vertex in vertices) == pytest.approx(0)


def test_renderable_hides_luxcore_invisible_objects():
    rs = _rs_scene(2)
    rs["objects"][0]["visible"]["luxcore"] = False
    assert renderable_to_bridge(rs)["objects"] == []


# --- image pipeline (R8: tonemap always applied) ---


@pytest.mark.parametrize(
    "backend",
    [DenoiseBackend.NONE, DenoiseBackend.OIDN, DenoiseBackend.BCD],
)
def test_image_pipeline_always_has_tonemap_and_gamma(backend: DenoiseBackend):
    props = _build_image_pipeline_props(RenderSettings(denoise=backend))
    assert "TONEMAP_REINHARD02" in props
    assert "GAMMA_CORRECTION" in props
    assert "film.imagepipeline.0.type = RGB_IMAGEPIPELINE" in props
    assert "film.imagepipeline.0.index = 0" in props


def test_image_pipeline_no_denoiser_when_none():
    props = _build_image_pipeline_props(RenderSettings(denoise=DenoiseBackend.NONE))
    assert "INTEL_OIDN" not in props
    assert "BCD_DENOISER" not in props
    # tonemap at slot 0, gamma at slot 1
    assert "film.imagepipelines.0.0.type = TONEMAP_REINHARD02" in props
    assert "film.imagepipelines.0.1.type = GAMMA_CORRECTION" in props


def test_image_pipeline_denoiser_between_tonemap_and_gamma():
    props = _build_image_pipeline_props(RenderSettings(denoise=DenoiseBackend.OIDN))
    assert "film.imagepipelines.0.0.type = TONEMAP_REINHARD02" in props
    assert "film.imagepipelines.0.1.type = INTEL_OIDN" in props
    assert "film.imagepipelines.0.2.type = GAMMA_CORRECTION" in props
    assert "film.imagepipelines.0.1.sharpness = 0.1" in props
    assert "film.imagepipelines.0.1.oidnmemory = 6000" in props


def test_image_pipeline_bcd_denoiser_no_oidnmemory():
    props = _build_image_pipeline_props(RenderSettings(denoise=DenoiseBackend.BCD))
    assert "film.imagepipelines.0.1.type = BCD_DENOISER" in props
    assert "oidnmemory" not in props
