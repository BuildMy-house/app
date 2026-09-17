"""R3: sky/environment, window-portal, and interior light emission.

Each test builds a real pyluxcore Scene and asserts the parsed
``ToProperties()`` output, so a passing test is proof that LuxCore accepted
the emitted property keys (Scene.Parse raises on unknown/invalid ones).
"""
import pytest

from luxcore.bridge import build_scene, renderable_to_bridge


def _floats(props, name):
    return [float(x) for x in props.Get(name).GetValuesString().split()]


def _rs_scene(background_color=0):
    return {
        "version": 1,
        "name": "t",
        "textures": [],
        "materials": [],
        "objects": [],
        "camera": {"position": [300, 150, 200], "yaw": 3.141592653589793,
                   "pitch": -0.2617993877991494, "fov": 60},
        "lights": [],
        "backgroundColor": background_color,
    }


def test_environment_light_parses_in_pyluxcore():
    import pyluxcore

    bridged = renderable_to_bridge(_rs_scene(background_color=0xCEC4FC))
    env = next(l for l in bridged["lights"] if l["type"] == "constantinfinite")
    assert env["color"] == pytest.approx([0.8078431373, 0.768627451, 0.9882352941])

    scene = build_scene(bridged, pyluxcore)
    props = scene.ToProperties()
    assert props.Get("scene.lights.env.type").GetString() == "constantinfinite"
    assert _floats(props, "scene.lights.env.color") == pytest.approx(env["color"])
    assert _floats(props, "scene.lights.env.gain") == pytest.approx([1.0, 1.0, 1.0])


def test_window_portal_emits_point_proxy_in_pyluxcore():
    import pyluxcore

    home = {"furniture": [
        {"id": "win1", "catalogId": "eTeks#window", "doorOrWindow": True,
         "x": 200, "y": 0, "elevation": 100, "height": 120, "width": 100},
        {"id": "sofa", "catalogId": "eTeks#sofa", "doorOrWindow": False,
         "x": 50, "y": 50, "elevation": 0, "height": 80, "width": 190},
    ]}
    bridged = renderable_to_bridge(_rs_scene(), home)
    portals = [l for l in bridged["lights"] if l["name"].startswith("portal_")]
    assert len(portals) == 1
    portal = portals[0]
    assert portal["type"] == "point"
    assert portal["position"] == pytest.approx([2.0, 0.0, 1.6])

    scene = build_scene(bridged, pyluxcore)
    props = scene.ToProperties()
    assert props.Get("scene.lights.portal_win1.type").GetString() == "point"
    assert _floats(props, "scene.lights.portal_win1.position") == pytest.approx([2.0, 0.0, 1.6])


def test_interior_lamp_emits_point_light_in_pyluxcore():
    import pyluxcore

    home = {"furniture": [
        {"id": "lamp1", "catalogId": "eTeks#floorUplight",
         "x": 100, "y": 200, "elevation": 0, "height": 150, "width": 30},
        {"id": "sofa", "catalogId": "eTeks#sofa",
         "x": 50, "y": 50, "elevation": 0, "height": 80, "width": 190},
    ]}
    bridged = renderable_to_bridge(_rs_scene(), home)
    lamps = [l for l in bridged["lights"] if l["name"].startswith("lamp_")]
    assert len(lamps) == 1
    lamp = lamps[0]
    assert lamp["type"] == "point"
    assert lamp["position"] == pytest.approx([1.0, 2.0, 0.75])

    scene = build_scene(bridged, pyluxcore)
    props = scene.ToProperties()
    assert props.Get("scene.lights.lamp_lamp1.type").GetString() == "point"
    assert _floats(props, "scene.lights.lamp_lamp1.position") == pytest.approx([1.0, 2.0, 0.75])


def test_catalog_light_heuristic_is_case_insensitive():
    home = {"furniture": [
        {"id": "l1", "catalogId": "eTeks#LIGHTSOURCE",
         "x": 10, "y": 20, "elevation": 0, "height": 100},
    ]}
    bridged = renderable_to_bridge(_rs_scene(), home)
    lamps = [l for l in bridged["lights"] if l["name"].startswith("lamp_")]
    assert len(lamps) == 1
