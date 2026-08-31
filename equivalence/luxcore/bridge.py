import math
from pathlib import Path
from typing import Any


def home_to_scene(home: dict[str, Any], asset_root: str | None = None) -> dict[str, Any]:
    source_root = Path(asset_root or Path(__file__).parents[2] / "homely" / "assets" / "models" / "sh3d")
    objects = []
    for wall in home.get("walls", []):
        dx = wall["xEnd"] - wall["xStart"]
        dy = wall["yEnd"] - wall["yStart"]
        objects.append({"type": "box", "name": wall["id"], "material": "wall",
                        "size": [max(math.hypot(dx, dy) / 100, 0.07),
                                 max(wall.get("thickness", 7) / 100, 0.03),
                                 (wall.get("height") or 250) / 100],
                        "position": [(wall["xStart"] + wall["xEnd"]) / 200,
                                     (wall["yStart"] + wall["yEnd"]) / 200, 0],
                        "rotation": math.degrees(math.atan2(dy, dx))})
    for room in home.get("rooms", []):
        objects.append({"type": "polygon", "name": room["id"], "material": "floor",
                        "vertices": [[x / 100, y / 100] for x, y in room["points"]], "z": 0, "height": 0})
    for furn in home.get("furniture", []):
        asset_name = str(furn.get("catalogId", "")).split("#")[-1]
        source = _find_asset(source_root, asset_name)
        objects.append({"type": "asset" if source.exists() else "box", "name": furn["id"], "material": "furniture",
                        "size": [furn["width"] / 100, furn["depth"] / 100, furn["height"] / 100],
                        "position": [furn.get("x", 0) / 100, furn.get("y", 0) / 100,
                                     furn.get("elevation", 0) / 100],
                        # SH3D/Three rotate around +Y; after Y-up -> Z-up and
                        # plan-Y -> LuxCore-Y, the equivalent Z rotation is reversed.
                        "rotation": -furn.get("angleDeg", 0), "path": str(source)})
    explicit_camera = home.get("renderCamera")
    if explicit_camera:
        lookat = [explicit_camera["orig"], explicit_camera["target"], explicit_camera.get("up", [0, 0, 1])]
        return {"materials": {"wall": {"type": "matte", "kd": [0.7, 0.7, 0.7]},
                               "floor": {"type": "matte", "kd": [0.9, 0.9, 0.88]},
                               "furniture": {"type": "matte", "kd": [0.6, 0.6, 0.75]}},
                "objects": objects, "lights": [{"type": "directional", "name": "sun",
                                                   "direction": [0, 0, -1], "gain": [3, 3, 3]}],
                "camera": {"lookat": lookat, "fov": explicit_camera.get("fov", 60)}}
    cam = home.get("cameras", {}).get("observer") or home.get("cameras", {}).get("top", {})
    yaw = math.radians(cam.get("yawDeg", 0))
    pitch = math.radians(cam.get("pitchDeg", 15))
    direction = [-math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), -math.sin(pitch)]
    distance = 5
    target = [cam.get("x", 200) / 100 + direction[0] * distance,
              cam.get("y", 150) / 100 + direction[1] * distance,
              max(cam.get("z", 900) / 100 + direction[2] * distance, 0)]
    return {"materials": {"wall": {"type": "matte", "kd": [0.7, 0.7, 0.7]},
                           "floor": {"type": "matte", "kd": [0.9, 0.9, 0.88]},
                           "furniture": {"type": "matte", "kd": [0.6, 0.6, 0.75]}},
            "objects": objects, "lights": [{"type": "directional", "name": "sun",
                                                "direction": [0, 0, -1], "gain": [3, 3, 3]}],
            "camera": {"lookat": [[cam.get("x", 200) / 100, cam.get("y", 150) / 100, cam.get("z", 900) / 100],
                                     target, [0, 1, 0]],
                       "fov": cam.get("fovDeg", 60)}}


def renderable_scene_to_lux(scene: dict, luxcore_module: Any | None = None, home: dict | None = None) -> Any:
    """Turn a TS RenderableScene JSON into a LuxCore scene.

    The RenderableScene is Y-up (height on Y, floor on XZ) and in centimetres;
    build_scene consumes Z-up metres. This reuses build_scene (and thus
    _box_to_mesh/_polygon_to_mesh/_load_obj) by translating the RenderableScene
    into the same ad-hoc bridge format that home_to_scene produces.
    """
    return build_scene(renderable_to_bridge(scene, home), luxcore_module)


def renderable_to_bridge(scene: dict, home: dict | None = None) -> dict:
    """Translate a RenderableScene into the ad-hoc bridge scene dict.

    When `home` is provided, ``furniture:<id>`` objects with a resolvable
    `catalogId` are replaced by their real SH3D OBJ mesh (mirroring
    home_to_scene's furniture handling); otherwise they fall back to a box.
    """
    materials = {}
    for mat in scene.get("materials", []):
        kd = _rs_rgb(mat.get("color", 0xFFFFFF))
        materials[mat["id"]] = _material_to_bridge(mat, kd)

    objects = []
    for obj in scene.get("objects", []):
        if obj.get("visible", {}).get("luxcore") is False:
            continue
        prims = obj.get("primitives") or []
        multi = len(prims) > 1
        for idx, prim in enumerate(prims):
            name = f"{obj['id']}:{idx}" if multi else obj["id"]
            if prim["type"] == "box":
                if obj["id"].startswith("furniture:") and home is not None:
                    item = _find_furniture(home, obj["id"][len("furniture:"):])
                    if item is not None and _resolve_asset(item) is not None:
                        objects.append(_furniture_to_asset(item, prim["materialId"]))
                        continue
                objects.append(_box_to_bridge(name, prim))
            elif prim["type"] == "polygon":
                objects.append(_polygon_to_bridge(name, prim))
            # extrudePolygon is not emitted by the current scene-builder; skip.

    camera = _camera_to_bridge(scene.get("camera", {}))
    lights = [_light_to_bridge(light) for light in scene.get("lights", [])]
    lights.append(_environment_light(scene.get("backgroundColor", 0xFFFFFF)))
    if home:
        lights.extend(_portal_lights(home))
        lights.extend(_interior_lights(home))
    return {"materials": materials, "objects": objects, "lights": lights, "camera": camera}


def _rs_rgb(color: int) -> list[float]:
    return [(color >> 16 & 0xFF) / 255, (color >> 8 & 0xFF) / 255, (color & 0xFF) / 255]


# Shininess (MaterialDef.shininess, 0-1) -> LuxCore material mapping.
#   shininess <= _GLOSSY2_THRESHOLD  -> `matte` (pure diffuse)
#   higher                           -> `glossy2` with roughness = 1 - shininess
# glossy2 property keys verified against LuxCore 2.11 shipped examples
# (pyluxcoretest/scenes/luxball/luxball-glossy2.scn): `type`, `kd`, `ks`,
# `uroughness`, `vroughness`, optional `index` (IOR, default 1.5).
_GLOSSY2_THRESHOLD = 0.01
_MIN_ROUGHNESS = 0.02
_DEFAULT_KS = [0.5, 0.5, 0.5]


def _material_to_bridge(mat: dict, kd: list[float]) -> dict:
    """Map a RenderableScene MaterialDef to a bridge material dict.

    `shininess` 0-1 (0 = matte, 1 = mirror-like) selects matte vs glossy2.
    `ks` defaults to a neutral specular since MaterialDef carries no specular
    colour; `index` is left unset so LuxCore's IOR default (1.5) applies.
    """
    shininess = float(mat.get("shininess", 0.0))
    if shininess <= _GLOSSY2_THRESHOLD:
        return {"type": "matte", "kd": kd}
    roughness = round(max(1.0 - shininess, _MIN_ROUGHNESS), 4)
    return {"type": "glossy2", "kd": kd, "ks": list(_DEFAULT_KS),
            "uroughness": roughness, "vroughness": roughness}


def _box_to_bridge(name: str, prim: dict) -> dict:
    """RenderableScene box -> bridge box (Y-up cm -> Z-up m, bottom-anchored)."""
    size_cm = prim["size"]  # [w, h, d] cm (h up)
    pos_cm = prim["position"]  # [px, py, pz] cm, py centred
    rotation = prim.get("rotation", [0, 0, 0])[1]  # ry radians (Y-up)
    # Z-up lux: size [w, d, h], position [px, pz, py - h/2], rotation about Z.
    return {"type": "box", "name": name, "material": prim["materialId"],
            "size": [size_cm[0] / 100, size_cm[2] / 100, size_cm[1] / 100],
            "position": [pos_cm[0] / 100, pos_cm[2] / 100,
                         (pos_cm[1] - size_cm[1] / 2) / 100],
            "rotation": -rotation * 180 / math.pi}


def _polygon_to_bridge(name: str, prim: dict) -> dict:
    """RenderableScene polygon -> bridge polygon (floor XZ, height on Y)."""
    return {"type": "polygon", "name": name, "material": prim["materialId"],
            "vertices": [[x / 100, z / 100] for x, z in prim["vertices"]],
            "z": prim.get("y", 0) / 100, "height": prim.get("height", 0) / 100}


def _find_furniture(home: dict, furniture_id: str) -> dict | None:
    for furn in home.get("furniture", []):
        if str(furn.get("id")) == furniture_id:
            return furn
    return None


def _resolve_asset(item: dict) -> Path | None:
    asset_root = Path(__file__).parents[2] / "homely" / "assets" / "models" / "sh3d"
    asset_name = str(item.get("catalogId", "")).split("#")[-1]
    source = _find_asset(asset_root, asset_name)
    return source if source.exists() else None


def _furniture_to_asset(item: dict, material_id: str) -> dict:
    """Furniture -> real OBJ asset (mirrors home_to_scene furniture handling)."""
    source = _resolve_asset(item) or ""
    return {"type": "asset", "name": item["id"], "material": material_id,
            "size": [item["width"] / 100, item["depth"] / 100, item["height"] / 100],
            "position": [item.get("x", 0) / 100, item.get("y", 0) / 100,
                         item.get("elevation", 0) / 100],
            "rotation": -item.get("angleDeg", 0), "path": str(source)}


def _camera_to_bridge(camera: dict) -> dict:
    if not camera:
        return {"lookat": [[0, 0, 5], [0, 0, 0], [0, 0, 1]], "fov": 60}
    pos = camera["position"]  # [plan_x, height, plan_y] cm
    yaw_rs = camera.get("yaw", 0.0)
    pitch_rs = camera.get("pitch", 0.0)
    eye = [pos[0] / 100, pos[2] / 100, pos[1] / 100]
    distance = 5
    direction = [-math.sin(yaw_rs) * math.cos(pitch_rs),
                 -math.cos(yaw_rs) * math.cos(pitch_rs),
                 math.sin(pitch_rs)]
    target = [eye[0] + direction[0] * distance,
              eye[1] + direction[1] * distance,
              max(eye[2] + direction[2] * distance, 0)]
    return {"lookat": [eye, target, [0, 1, 0]], "fov": camera.get("fov", 60)}


def _light_to_bridge(light: dict) -> dict:
    color = _rs_rgb(light.get("color", 0xFFFFFF))
    intensity = light.get("intensity", 1.0)
    gain = [round(c * intensity * 3, 4) for c in color]
    if light.get("type") == "point":
        return {"type": "point", "name": light.get("id", "light"),
                "position": light.get("position", [0, 0, 5]), "gain": gain}
    direction = light.get("direction", [0, 0, -1])
    # Y-up direction [x, y, z] -> Z-up [x, z, y].
    return {"type": "directional", "name": light.get("id", "light"),
            "direction": [direction[0], direction[2], direction[1]], "gain": gain}


# Gain scales for the three R3 light classes. Environment gain is a radiance
# multiplier on the sky colour; portal/interior are point-light gains in the
# same absolute scale the existing point-light default uses (5000).
_ENV_GAIN = [1.0, 1.0, 1.0]
_PORTAL_GAIN = [1500.0, 1500.0, 1500.0]
_INTERIOR_GAIN = [2500.0, 2500.0, 2500.0]


def _environment_light(bg_color: int) -> dict:
    """Sky/environment light: constant-infinite radiance from the scene's
    background (sky) colour. `constantinfinite` is the verified LuxCore 2.11
    constant-colour environment light (`color` + `gain` float3)."""
    return {"type": "constantinfinite", "name": "env",
            "color": _rs_rgb(bg_color), "gain": list(_ENV_GAIN)}


def _portal_lights(home: dict) -> list[dict]:
    """Light portal per wall opening (doorOrWindow furniture), as point lights.

    pyluxcore 2.11.1 has no portal light type (Scene.Parse rejects
    ``type = portal`` with "Unknown light type: portal"), so each opening is
    approximated by a point light at its centre.
    # ponytail: point-light proxy; upgrade to real area/portal lights when
    # LuxCore gains them.
    """
    lights = []
    for item in home.get("furniture", []):
        if not item.get("doorOrWindow"):
            continue
        z = item.get("elevation", 0) + item.get("height", 0) / 2
        lights.append({"type": "point",
                       "name": f"portal_{_sanitize(str(item.get('id', '')))}",
                       "position": [item.get("x", 0) / 100, item.get("y", 0) / 100, z / 100],
                       "gain": list(_PORTAL_GAIN)})
    return lights


def _interior_lights(home: dict) -> list[dict]:
    """Point light per light-fixture furniture item (catalogId contains
    "light"). The catalogId heuristic is the documented MVP: no schema field
    is added to Furniture to keep the bridge disjoint from homely's core."""
    lights = []
    for item in home.get("furniture", []):
        if "light" not in str(item.get("catalogId", "")).lower():
            continue
        z = item.get("elevation", 0) + item.get("height", 0) / 2
        lights.append({"type": "point",
                       "name": f"lamp_{_sanitize(str(item.get('id', '')))}",
                       "position": [item.get("x", 0) / 100, item.get("y", 0) / 100, z / 100],
                       "gain": list(_INTERIOR_GAIN)})
    return lights


def _material_props(prefix: str, mat: dict) -> str:
    """Render a bridge material dict as fully-prefixed LuxCore property lines.

    Emits `type` + `kd`, then any optional glossy2 fields (`ks`, `uroughness`,
    `vroughness`, `index`) that are present. Scalar values (roughness/index)
    are emitted as-is; list values (kd/ks) are space-joined.
    """
    def fmt(value: Any) -> str:
        if isinstance(value, (list, tuple)):
            return " ".join(map(str, value))
        return str(value)

    lines = [
        f"{prefix}type = {mat.get('type', 'matte')}",
        f"{prefix}kd = {fmt(mat.get('kd', [0.5, 0.5, 0.5]))}",
    ]
    for key in ("ks", "uroughness", "vroughness", "index"):
        value = mat.get(key)
        if value is not None:
            lines.append(f"{prefix}{key} = {fmt(value)}")
    return "\n".join(lines)


def build_scene(scene_data: dict, luxcore_module: Any | None = None) -> Any:
    if luxcore_module is None:
        import pyluxcore as luxcore_module
    scene = luxcore_module.Scene()
    props = luxcore_module.Properties()
    for name, mat in scene_data.get("materials", {}).items():
        prefix = f"scene.materials.{name}."
        props.SetFromString(_material_props(prefix, mat))
    for obj in scene_data.get("objects", []):
        obj_type = obj.get("type", "mesh")
        if obj_type == "asset":
            loaded = _load_obj_full(obj["path"], obj.get("size", [1, 1, 1]), obj.get("position", [0, 0, 0]), obj.get("rotation", 0))
            vertices, faces = loaded["vertices"], loaded["faces"]
            if not vertices or not faces:
                continue
            obj_name = obj.get("name", "asset")
            if loaded["materials"] and loaded["face_materials"]:
                _emit_mtl_asset(scene, props, obj_name, obj.get("material", ""), loaded)
            else:
                mesh_name = f"mesh_{obj_name}"
                scene.DefineMesh(mesh_name, vertices, faces, None, None, None, None, None)
                prefix = f"scene.objects.{obj_name}."
                props.SetFromString(f"{prefix}material = {obj.get('material', '')}\n{prefix}shape = {mesh_name}")
            continue
        if obj_type == "box":
            vertices, faces = _box_to_mesh(obj.get("size", [1, 1, 1]), obj.get("position", [0, 0, 0]), obj.get("rotation", 0))
        elif obj_type == "polygon":
            vertices, faces = _polygon_to_mesh(obj.get("vertices", []), obj.get("z", 0), obj.get("height", 2.4))
        else:
            vertices, faces = obj.get("vertices", []), obj.get("triangles", [])
        if vertices and faces:
            prefix = f"scene.objects.{obj.get('name', 'object')}."
            props.SetFromString(f"{prefix}material = {obj.get('material', '')}\n{prefix}vertices = {' '.join(map(str, vertices))}\n{prefix}faces = {' '.join(map(str, faces))}")
    for light in scene_data.get("lights", []):
        prefix = f"scene.lights.{light.get('name', 'light')}."
        light_type = light.get("type")
        if light_type == "directional":
            props.SetFromString(f"{prefix}type = sharpdistant\n{prefix}direction = {' '.join(map(str, light.get('direction', [0, 0, -1])))}\n{prefix}gain = {' '.join(map(str, light.get('gain', [1, 1, 1])))}")
        elif light_type == "constantinfinite":
            props.SetFromString(f"{prefix}type = constantinfinite\n{prefix}color = {' '.join(map(str, light.get('color', [1, 1, 1])))}\n{prefix}gain = {' '.join(map(str, light.get('gain', [1, 1, 1])))}")
        else:
            props.SetFromString(f"{prefix}type = point\n{prefix}position = {' '.join(map(str, light.get('position', [0, 0, 5])))}\n{prefix}gain = {' '.join(map(str, light.get('gain', [5000, 5000, 5000])))}")
    camera = scene_data.get("camera", {})
    lookat = camera.get("lookat", [[0, 0, 5], [0, 0, 0], [0, 0, 1]])
    props.SetFromString("scene.camera.type = perspective\n" +
                       f"scene.camera.lookat.orig = {' '.join(map(str, lookat[0]))}\n" +
                       f"scene.camera.lookat.target = {' '.join(map(str, lookat[1]))}\n" +
                       f"scene.camera.up = {' '.join(map(str, lookat[2]))}\n" +
                       f"scene.camera.fieldofview = {camera.get('fov', 60)}")
    scene.Parse(props)
    return scene


def _box_to_mesh(size: list, position: list | None = None, rotation: float = 0):
    x, y, z = size[0] / 2, size[1] / 2, size[2]
    px, py, pz = position or [0, 0, 0]
    angle = math.radians(rotation)
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    vertices = []
    for vx, vy, vz in [(-x, -y, 0), (x, -y, 0), (x, y, 0), (-x, y, 0),
                       (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)]:
        vertices += [vx * cos_a - vy * sin_a + px, vx * sin_a + vy * cos_a + py, vz + pz]
    faces = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 2, 6, 7, 2, 7, 3, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2]
    return vertices, faces


def _polygon_to_mesh(vertices: list, z: float, height: float):
    n = len(vertices)
    if n < 3:
        return [], []
    points = [coord for vertex in vertices for coord in (vertex[0], vertex[1], z)]
    if height == 0:
        faces = []
        for i in range(1, n - 1):
            faces += [0, i, i + 1]
        return points, faces
    points += [coord for vertex in vertices for coord in (vertex[0], vertex[1], z + height)]
    faces = []
    for i in range(n):
        a, b, c, d = i, (i + 1) % n, (i + 1) % n + n, i + n
        faces += [a, b, c, a, c, d]
    return points, faces


def _sanitize(name: str) -> str:
    return "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in name)


def _load_mtl(mtl_path: Path) -> dict[str, dict]:
    """Parse a Wavefront .mtl into {name: {kd: [r,g,b]|None, map_kd: str|None}}."""
    materials: dict[str, dict] = {}
    if not mtl_path.is_file():
        return materials
    current: str | None = None
    for line in mtl_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        fields = line.split()
        if not fields:
            continue
        if fields[0] == "newmtl" and len(fields) >= 2:
            current = _sanitize(fields[1])
            materials[current] = {"kd": None, "map_kd": None}
        elif current is not None:
            if fields[0] == "Kd" and len(fields) >= 4:
                materials[current]["kd"] = [float(fields[1]), float(fields[2]), float(fields[3])]
            elif fields[0] == "map_Kd" and len(fields) >= 2:
                materials[current]["map_kd"] = fields[-1]
    return materials


def _parse_obj_raw(source: Path) -> dict | None:
    """Single-pass OBJ parse: v/vt/f (corners keep vidx+uvidx+material), mtllib.

    Negative indices are left signed and resolved later against full lists.
    """
    raw_vertices: list = []
    uvs: list = []
    faces: list = []
    mtllib: str | None = None
    current_mat: str | None = None
    for line in source.read_text(encoding="utf-8", errors="ignore").splitlines():
        fields = line.split()
        if not fields:
            continue
        if fields[0] == "v" and len(fields) >= 4:
            raw_vertices.append((float(fields[1]), float(fields[2]), float(fields[3])))
        elif fields[0] == "vt" and len(fields) >= 3:
            uvs.append((float(fields[1]), float(fields[2])))
        elif fields[0] == "mtllib" and len(fields) >= 2:
            mtllib = fields[1]
        elif fields[0] == "usemtl" and len(fields) >= 2:
            current_mat = fields[1]
        elif fields[0] == "f" and len(fields) >= 4:
            vidx, uvidx = [], []
            for part in fields[1:]:
                comps = part.split("/")
                vidx.append(int(comps[0]))
                uvidx.append(int(comps[1]) if len(comps) > 1 and comps[1] else None)
            faces.append({"vidx": vidx, "uvidx": uvidx, "mat": current_mat})
    if not raw_vertices or not faces:
        return None
    return {"vertices": raw_vertices, "uvs": uvs, "faces": faces, "mtllib": mtllib}


def _transform_vertices(raw_vertices, size, position, rotation):
    # SH3D OBJ resources are Y-up; LuxCore uses Z-up. Map source X/Z to the
    # floor plane and source Y to height, then scale/centre/rotate/offset.
    vertices = [(x, z, y) for x, y, z in raw_vertices]
    mins = [min(v[i] for v in vertices) for i in range(3)]
    maxs = [max(v[i] for v in vertices) for i in range(3)]
    source_max = max(maxs[i] - mins[i] for i in range(3)) or 1
    scale = max(size) / source_max
    cx, cy = (mins[0] + maxs[0]) / 2, (mins[1] + maxs[1]) / 2
    angle = math.radians(rotation)
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    px, py, pz = position
    transformed = []
    for x, y, z in vertices:
        lx, ly = (x - cx) * scale, (y - cy) * scale
        transformed.append((lx * cos_a - ly * sin_a + px,
                            lx * sin_a + ly * cos_a + py,
                            (z - mins[2]) * scale + pz))
    return transformed


def _load_obj_full(path: str, size: list, position: list, rotation: float) -> dict:
    """Parse OBJ + MTL, returning vertices/faces plus UVs and per-material info.

    Returns {'vertices', 'faces', 'uvs', 'materials', 'face_materials',
    'coverage'}. ``uvs``/``materials``/``face_materials`` are None when the
    asset carries no usable texture/material data. ``coverage`` is the M37
    gate fraction: faces with at least one UV corner / total faces.
    """
    empty = {"vertices": [], "faces": [], "uvs": None, "materials": None,
             "face_materials": None, "coverage": 0.0}
    source = Path(path)
    if not source.is_file():
        return empty
    raw = _parse_obj_raw(source)
    if raw is None:
        return empty

    n_vert = len(raw["vertices"])
    n_uv = len(raw["uvs"])
    mtl_materials = _load_mtl(source.parent / raw["mtllib"]) if raw["mtllib"] else {}

    def v_idx(i: int) -> int:
        return i - 1 if i > 0 else n_vert + i

    def u_idx(i: int) -> int:
        return i - 1 if i > 0 else n_uv + i

    face_count = len(raw["faces"])
    faces_with_uv = sum(1 for f in raw["faces"] if any(u is not None for u in f["uvidx"]))
    coverage = faces_with_uv / face_count if face_count else 0.0
    use_uvs = bool(raw["uvs"]) and coverage > 0.5

    if not mtl_materials:
        # No MTL: preserve the legacy single-mesh flat path.
        resolved = []
        for f in raw["faces"]:
            idx = [v_idx(i) for i in f["vidx"]]
            for i in range(1, len(idx) - 1):
                resolved.append((idx[0], idx[i], idx[i + 1]))
        return {"vertices": _transform_vertices(raw["vertices"], size, position, rotation),
                "faces": resolved, "uvs": None, "materials": None,
                "face_materials": None, "coverage": coverage}

    materials = {}
    for name, mtl in mtl_materials.items():
        map_kd = mtl.get("map_kd")
        map_kd_path = (source.parent / map_kd).resolve() if map_kd else None
        textured = bool(map_kd_path and map_kd_path.is_file()) and use_uvs
        materials[name] = {"kd": mtl.get("kd"), "map_kd": str(map_kd_path) if textured else None,
                           "textured": textured}

    if use_uvs:
        # Split vertices on UV seams so textured sub-meshes carry valid UVs.
        vert_map: dict = {}
        new_vertices: list = []
        new_uvs: list = []
        resolved: list = []
        face_materials: list = []
        for f in raw["faces"]:
            corner_idx = []
            for vi, ui in zip(f["vidx"], f["uvidx"]):
                vi_r = v_idx(vi)
                ui_r = u_idx(ui) if ui is not None else 0
                key = (vi_r, ui_r)
                if key not in vert_map:
                    vert_map[key] = len(new_vertices)
                    new_vertices.append(raw["vertices"][vi_r])
                    new_uvs.append(raw["uvs"][ui_r])
                corner_idx.append(vert_map[key])
            mat = _sanitize(f["mat"]) if f["mat"] else None
            for i in range(1, len(corner_idx) - 1):
                resolved.append((corner_idx[0], corner_idx[i], corner_idx[i + 1]))
                face_materials.append(mat)
        return {"vertices": _transform_vertices(new_vertices, size, position, rotation),
                "faces": resolved, "uvs": new_uvs, "materials": materials,
                "face_materials": face_materials, "coverage": coverage}

    # MTL present but UVs unusable: per-material flat Kd, no vertex splitting.
    resolved = []
    face_materials = []
    for f in raw["faces"]:
        idx = [v_idx(i) for i in f["vidx"]]
        mat = _sanitize(f["mat"]) if f["mat"] else None
        for i in range(1, len(idx) - 1):
            resolved.append((idx[0], idx[i], idx[i + 1]))
            face_materials.append(mat)
    return {"vertices": _transform_vertices(raw["vertices"], size, position, rotation),
            "faces": resolved, "uvs": None, "materials": materials,
            "face_materials": face_materials, "coverage": coverage}


def _load_obj(path: str, size: list, position: list, rotation: float):
    loaded = _load_obj_full(path, size, position, rotation)
    return loaded["vertices"], loaded["faces"]


def _emit_mtl_asset(scene, props, obj_name: str, fallback_mat: str, loaded: dict) -> None:
    """Emit per-material sub-meshes for an OBJ with MTL: imagemap or flat Kd."""
    vertices = loaded["vertices"]
    uvs = loaded["uvs"]
    materials = loaded["materials"]
    groups: dict = {}
    for tri, mat in zip(loaded["faces"], loaded["face_materials"]):
        groups.setdefault(mat, []).append(tri)
    for mat_name, tris in groups.items():
        if mat_name is None:
            key = f"{obj_name}_unassigned"
            scene.DefineMesh(f"mesh_{key}", vertices, tris, None, uvs, None, None, None)
            props.SetFromString(f"scene.objects.{key}.material = {fallback_mat}\n"
                                f"scene.objects.{key}.shape = mesh_{key}")
            continue
        mat_def = materials.get(mat_name) or {}
        key = f"{obj_name}_{mat_name}"
        mesh_name = f"mesh_{key}"
        scene.DefineMesh(mesh_name, vertices, tris, None, uvs, None, None, None)
        mat_prefix = f"scene.materials.{mat_name}."
        if mat_def.get("textured") and mat_def.get("map_kd"):
            tex_name = f"tex_{mat_name}"
            props.SetFromString(
                f"scene.textures.{tex_name}.type = imagemap\n"
                f"scene.textures.{tex_name}.file = {mat_def['map_kd']}\n"
                f"{mat_prefix}type = matte\n"
                f"{mat_prefix}kd = {tex_name}"
            )
        else:
            kd = mat_def.get("kd") or [0.6, 0.6, 0.75]
            props.SetFromString(f"{mat_prefix}type = matte\n"
                                f"{mat_prefix}kd = {' '.join(map(str, kd))}")
        props.SetFromString(f"scene.objects.{key}.material = {mat_name}\n"
                            f"scene.objects.{key}.shape = {mesh_name}")


def _asset_materials(path: str) -> dict | None:
    loaded = _load_obj_full(path, [1, 1, 1], [0, 0, 0], 0)
    if not loaded["materials"] or not loaded["face_materials"]:
        return None
    return {"materials": loaded["materials"], "face_materials": loaded["face_materials"],
            "coverage": loaded["coverage"]}


def _find_asset(root: Path, name: str) -> Path:
    expected = f"{name}.obj".casefold()
    for candidate in root.rglob("*.obj"):
        if candidate.name.casefold() == expected:
            return candidate
    return root / expected
