"""R4: multi-camera batch rendering + non-square aspect handling.

The aspect-ratio test builds a real pyluxcore Scene and asserts the parsed
``scene.camera.screenwindow`` property, so a passing test is proof LuxCore
accepted it. The end-to-end test renders two differently-positioned cameras
from one RenderableScene and asserts pixel-different PNGs at the requested
(non-square) resolution.
"""
import io

import numpy as np
import pytest
from PIL import Image

from luxcore.bridge import build_scene, render_cameras, renderable_to_bridge
from luxcore.renderer import RenderSettings


def _rs_scene():
    """A two-box RenderableScene with a wall and a floor for both cameras."""
    return {
        "version": 1,
        "name": "t",
        "textures": [],
        "materials": [
            {"id": "mat_wall", "color": 0xD2D2D2, "shininess": 0, "opacity": 1, "model": "standard"},
            {"id": "mat_floor", "color": 0xC8C8C8, "shininess": 0, "opacity": 1, "model": "standard"},
        ],
        "objects": [
            {"id": "wall:w1", "name": "Wall", "primitives": [
                {"type": "box", "position": [200, 125, 0], "size": [400, 250, 15],
                 "rotation": [0, 0, 0], "materialId": "mat_wall"}],
             "visible": {"plan": True, "threeD": True, "luxcore": True}},
            {"id": "room:r1", "name": "Floor", "primitives": [
                {"type": "polygon", "vertices": [[0, 0], [400, 0], [400, 300], [0, 300]],
                 "y": 0, "height": 0, "materialId": "mat_floor"}],
             "visible": {"plan": True, "threeD": True, "luxcore": True}},
        ],
        "camera": {"position": [300, 150, 200], "yaw": 3.141592653589793,
                   "pitch": -0.2617993877991494, "fov": 58, "projection": "perspective"},
        "lights": [],
        "backgroundColor": 0xCEC4FC,
    }


def _floats(props, name):
    return [float(x) for x in props.Get(name).GetValuesString().split()]


def test_build_scene_emits_screenwindow_for_aspect():
    import pyluxcore

    bridged = renderable_to_bridge(_rs_scene())
    bridged["camera"]["aspect"] = 2.0
    scene = build_scene(bridged, pyluxcore)
    props = scene.ToProperties()
    assert _floats(props, "scene.camera.screenwindow") == pytest.approx([-2.0, 2.0, -1.0, 1.0])
    assert _floats(props, "scene.camera.fieldofview") == pytest.approx([58.0])


def test_build_scene_leaves_screenwindow_unset_without_aspect():
    import pyluxcore

    bridged = renderable_to_bridge(_rs_scene())
    scene = build_scene(bridged, pyluxcore)
    props = scene.ToProperties()
    with pytest.raises(RuntimeError):
        props.Get("scene.camera.screenwindow")


def test_render_cameras_produces_distinct_images_at_requested_aspect():
    """DoD: 2 differently-positioned cameras -> 2 pixel-different PNGs.

    Non-square resolution (240x120, aspect 2:1) is used so the aspect path is
    exercised; each PNG must decode to exactly the requested dimensions.
    """
    settings = RenderSettings(width=240, height=120, samples_per_pixel=8, seconds=60)
    cameras = [
        {"name": "front", "camera": {"position": [200, 150, 300], "yaw": 3.141592653589793,
                                     "pitch": -0.2617993877991494, "fov": 58}},
        {"name": "side", "camera": {"position": [-100, 150, 150], "yaw": -1.5707963267948966,
                                    "pitch": -0.2617993877991494, "fov": 58}},
    ]
    pngs = render_cameras(_rs_scene(), cameras, settings=settings)

    assert set(pngs) == {"front", "side"}
    front = np.array(Image.open(io.BytesIO(pngs["front"])).convert("RGB"))
    side = np.array(Image.open(io.BytesIO(pngs["side"])).convert("RGB"))
    assert front.shape == (120, 240, 3)
    assert side.shape == (120, 240, 3)
    assert not np.array_equal(front, side)
