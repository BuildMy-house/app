"""R2: MaterialDef.shininess -> LuxCore material mapping (matte vs glossy2)."""
import pytest

from luxcore.bridge import (
    _material_to_bridge,
    _rs_rgb,
    build_scene,
    renderable_to_bridge,
)


def _mat(color=0x336699, shininess=0.0):
    return {"id": "mat", "color": color, "shininess": shininess,
            "opacity": 1, "model": "standard"}


def test_shininess_zero_maps_to_matte():
    bridged = _material_to_bridge(_mat(shininess=0.0), _rs_rgb(0x336699))
    assert bridged == {"type": "matte", "kd": [0.2, 0.4, 0.6]}


def test_shininess_near_zero_stays_matte():
    bridged = _material_to_bridge(_mat(shininess=0.01), _rs_rgb(0x336699))
    assert bridged["type"] == "matte"


def test_high_shininess_maps_to_glossy2():
    bridged = _material_to_bridge(_mat(shininess=0.8), _rs_rgb(0x336699))
    assert bridged["type"] == "glossy2"
    assert bridged["kd"] == [0.2, 0.4, 0.6]
    assert bridged["ks"] == [0.5, 0.5, 0.5]
    # roughness = 1 - shininess
    assert bridged["uroughness"] == pytest.approx(0.2)
    assert bridged["vroughness"] == pytest.approx(0.2)


def test_mirror_like_shininess_clamps_roughness():
    bridged = _material_to_bridge(_mat(shininess=1.0), _rs_rgb(0x336699))
    assert bridged["type"] == "glossy2"
    assert bridged["uroughness"] == pytest.approx(0.02)
    assert bridged["vroughness"] == pytest.approx(0.02)


def _rs_scene(materials, objects):
    return {
        "version": 1,
        "materials": materials,
        "objects": objects,
        "camera": {"position": [200, 200, 500], "yaw": 0, "pitch": -0.3, "fov": 60},
        "lights": [],
        "textures": [],
    }


def test_renderable_to_bridge_maps_shininess():
    rs = _rs_scene(
        [
            {"id": "mat_gloss", "color": 0x336699, "shininess": 0.6,
             "opacity": 1, "model": "standard"},
            {"id": "mat_flat", "color": 0xcccccc, "shininess": 0,
             "opacity": 1, "model": "standard"},
        ],
        [
            {"id": "furniture:g", "name": "g", "primitives": [
                {"type": "box", "position": [200, 50, 150], "size": [100, 100, 100],
                 "rotation": [0, 0, 0], "materialId": "mat_gloss"}],
             "visible": {"plan": True, "threeD": True, "luxcore": True}},
            {"id": "furniture:f", "name": "f", "primitives": [
                {"type": "box", "position": [100, 50, 150], "size": [100, 100, 100],
                 "rotation": [0, 0, 0], "materialId": "mat_flat"}],
             "visible": {"plan": True, "threeD": True, "luxcore": True}},
        ],
    )
    bridged = renderable_to_bridge(rs)
    assert bridged["materials"]["mat_gloss"]["type"] == "glossy2"
    assert bridged["materials"]["mat_gloss"]["uroughness"] == pytest.approx(0.4)
    assert bridged["materials"]["mat_flat"]["type"] == "matte"


def test_ceiling_material_is_distinct_from_floor():
    # Mirrors scene-builder.ts: floor uses room.floorColor/DEFAULT_FLOOR_COLOR,
    # ceiling uses its own DEFAULT_CEILING_COLOR material with a distinct id.
    rs = _rs_scene(
        [
            {"id": "mat_floor", "color": 0xc8c8c8, "shininess": 0, "opacity": 1, "model": "standard"},
            {"id": "mat_ceil", "color": 0xf0f0f0, "shininess": 0, "opacity": 1, "model": "standard"},
        ],
        [
            {"id": "room:r1", "name": "Room", "primitives": [
                {"type": "polygon", "vertices": [[0, 0], [400, 0], [400, 300], [0, 300]],
                 "y": 0, "height": 0, "materialId": "mat_floor"}],
             "visible": {"plan": True, "threeD": True, "luxcore": True}},
            {"id": "ceiling:r1", "name": "Ceiling", "primitives": [
                {"type": "polygon", "vertices": [[0, 0], [400, 0], [400, 300], [0, 300]],
                 "y": 250, "height": 0, "materialId": "mat_ceil"}],
             "visible": {"plan": False, "threeD": True, "luxcore": True}},
        ],
    )
    bridged = renderable_to_bridge(rs)
    assert set(bridged["materials"]) == {"mat_floor", "mat_ceil"}
    assert bridged["materials"]["mat_floor"]["kd"] != bridged["materials"]["mat_ceil"]["kd"]
    floor_obj = next(o for o in bridged["objects"] if o["name"].startswith("room:"))
    ceil_obj = next(o for o in bridged["objects"] if o["name"].startswith("ceiling:"))
    assert floor_obj["material"] != ceil_obj["material"]


def test_glossy2_material_properties_parse_in_pyluxcore():
    import pyluxcore

    scene = build_scene(
        {
            "materials": {
                "shiny": {"type": "glossy2", "kd": [0.2, 0.4, 0.6], "ks": [0.5, 0.5, 0.5],
                          "uroughness": 0.2, "vroughness": 0.2},
                "flat": {"type": "matte", "kd": [0.5, 0.5, 0.5]},
            },
            "objects": [],
            "lights": [],
            "camera": {"lookat": [[2, 1.5, 9], [2, 1.5, 0], [0, 1, 0]], "fov": 60},
        },
        pyluxcore,
    )
    props = scene.ToProperties()

    def get(name):
        return props.Get(name).GetString()

    assert get("scene.materials.shiny.type") == "glossy2"
    assert get("scene.materials.shiny.kd") == "0.2 0.4 0.6"
    assert get("scene.materials.shiny.ks") == "0.5 0.5 0.5"
    assert get("scene.materials.shiny.uroughness") == "0.2"
    assert get("scene.materials.shiny.vroughness") == "0.2"
    assert get("scene.materials.flat.type") == "matte"
    assert get("scene.materials.flat.kd") == "0.5 0.5 0.5"
