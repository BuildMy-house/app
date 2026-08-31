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
        materials[mat["id"]] = {"type": "matte", "kd": kd}

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
    return {"materials": materials, "objects": objects, "lights": lights, "camera": camera}


def _rs_rgb(color: int) -> list[float]:
    return [(color >> 16 & 0xFF) / 255, (color >> 8 & 0xFF) / 255, (color & 0xFF) / 255]


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


def build_scene(scene_data: dict, luxcore_module: Any | None = None) -> Any:
    if luxcore_module is None:
        import pyluxcore as luxcore_module
    scene = luxcore_module.Scene()
    props = luxcore_module.Properties()
    for name, mat in scene_data.get("materials", {}).items():
        prefix = f"scene.materials.{name}."
        props.SetFromString(f"{prefix}type = {mat.get('type', 'matte')}\n{prefix}kd = {' '.join(map(str, mat.get('kd', [0.5, 0.5, 0.5])))}")
    for obj in scene_data.get("objects", []):
        obj_type = obj.get("type", "mesh")
        if obj_type == "asset":
            vertices, faces = _load_obj(obj["path"], obj.get("size", [1, 1, 1]), obj.get("position", [0, 0, 0]), obj.get("rotation", 0))
            if vertices and faces:
                mesh_name = f"mesh_{obj.get('name', 'asset')}"
                scene.DefineMesh(mesh_name, vertices, faces, None, None, None, None, None)
                prefix = f"scene.objects.{obj.get('name', 'object')}."
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
        if light.get("type") == "directional":
            props.SetFromString(f"{prefix}type = sharpdistant\n{prefix}direction = {' '.join(map(str, light.get('direction', [0, 0, -1])))}\n{prefix}gain = {' '.join(map(str, light.get('gain', [1, 1, 1])))}")
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


def _load_obj(path: str, size: list, position: list, rotation: float):
    source = Path(path)
    if not source.is_file():
        return [], []
    raw_vertices = []
    faces = []
    for line in source.read_text(encoding="utf-8", errors="ignore").splitlines():
        fields = line.split()
        if len(fields) >= 4 and fields[0] == "v":
            raw_vertices.append((float(fields[1]), float(fields[2]), float(fields[3])))
        elif len(fields) >= 4 and fields[0] == "f":
            indices = [int(part.split("/")[0]) for part in fields[1:]]
            indices = [(i - 1 if i > 0 else len(raw_vertices) + i) for i in indices]
            for i in range(1, len(indices) - 1):
                faces.append((indices[0], indices[i], indices[i + 1]))
    if not raw_vertices or not faces:
        return [], []
    # SH3D OBJ resources are Y-up; LuxCore uses Z-up. Map source X/Z to the
    # floor plane and source Y to height.
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
        transformed += [lx * cos_a - ly * sin_a + px, lx * sin_a + ly * cos_a + py, (z - mins[2]) * scale + pz]
    return [tuple(transformed[i:i + 3]) for i in range(0, len(transformed), 3)], faces


def _find_asset(root: Path, name: str) -> Path:
    expected = f"{name}.obj".casefold()
    for candidate in root.rglob("*.obj"):
        if candidate.name.casefold() == expected:
            return candidate
    return root / expected
