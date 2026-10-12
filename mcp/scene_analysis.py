"""Small, JSON-safe scene checks for agents that do not need pixels."""

from __future__ import annotations

from collections import defaultdict
from math import acos, atan2, ceil, cos, hypot, radians, sin, tan
from typing import Any


def _area(points: list[list[float]]) -> float:
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1]))) / 2


def _inside(point: tuple[float, float], polygon: list[list[float]]) -> bool:
    x, y = point
    inside = False
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
    return inside


def _on_segment(point: tuple[float, float], a: list[float], b: list[float]) -> bool:
    cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])
    return (abs(cross) <= 1e-6
            and min(a[0], b[0]) <= point[0] <= max(a[0], b[0])
            and min(a[1], b[1]) <= point[1] <= max(a[1], b[1]))


def _orientation(a: list[float], b: list[float], c: list[float]) -> int:
    cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    if cross > 1e-6:
        return 1
    if cross < -1e-6:
        return -1
    return 0


def _segments_intersect(p1: list[float], p2: list[float], p3: list[float], p4: list[float]) -> bool:
    o1, o2 = _orientation(p1, p2, p3), _orientation(p1, p2, p4)
    o3, o4 = _orientation(p3, p4, p1), _orientation(p3, p4, p2)
    if o1 != o2 and o3 != o4:
        return True
    return ((o1 == 0 and _on_segment(p3, p1, p2)) or (o2 == 0 and _on_segment(p4, p1, p2))
            or (o3 == 0 and _on_segment(p1, p3, p4)) or (o4 == 0 and _on_segment(p2, p3, p4)))


def _self_intersects(polygon: list[list[float]]) -> bool:
    n = len(polygon)
    for i in range(n):
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            if _segments_intersect(polygon[i], polygon[(i + 1) % n], polygon[j], polygon[(j + 1) % n]):
                return True
    return False


def _strictly_inside(point: tuple[float, float], polygon: list[list[float]]) -> bool:
    edges = zip(polygon, polygon[1:] + polygon[:1])
    return not any(_on_segment(point, a, b) for a, b in edges) and _inside(point, polygon)


def _samples(polygon: list[list[float]]) -> list[tuple[float, float]]:
    samples = []
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        samples.append((a[0], a[1]))
        for t in (0.25, 0.5, 0.75):
            samples.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return samples


def _rooms_overlap(a: list[list[float]], b: list[list[float]]) -> bool:
    if len(a) < 3 or len(b) < 3:
        return False
    for polygon, other in ((a, b), (b, a)):
        samples = _samples(polygon)
        hits = sum(1 for point in samples if _strictly_inside(point, other))
        if hits / len(samples) >= 0.1:
            return True
    return False


def _bounds(points: list[tuple[float, float]]) -> dict[str, float] | None:
    if not points:
        return None
    xs, ys = zip(*points)
    return {"minX": min(xs), "minY": min(ys), "maxX": max(xs), "maxY": max(ys),
            "width": max(xs) - min(xs), "height": max(ys) - min(ys)}


_OVERLAP_EPSILON_CM = 1e-6
# Same constants and slice construction as src/plan/wall-solids.ts, so the
# validator and the in-app clearance agree on what "overlaps a wall" means.
_ARC_TOLERANCE_CM = 0.005
_MAX_ARC_SLICES = 4096
_RELAX_PASSES = 64
_SEED_GRID = 5

Solid = tuple[list[tuple[float, float]], list[tuple[float, float]]]


def _rect_solid(wall: dict[str, Any]) -> Solid | None:
    xs, ys, xe, ye = wall["xStart"], wall["yStart"], wall["xEnd"], wall["yEnd"]
    length = hypot(xe - xs, ye - ys)
    if length <= 0:
        return None
    tx, ty = (xe - xs) / length, (ye - ys) / length
    nx, ny = -ty, tx
    cx, cy, hl = (xs + xe) / 2, (ys + ye) / 2, length / 2
    ht = max(0.0, wall.get("thickness") or 0.0) / 2
    pts = [(cx - tx * hl - nx * ht, cy - ty * hl - ny * ht), (cx + tx * hl - nx * ht, cy + ty * hl - ny * ht),
           (cx + tx * hl + nx * ht, cy + ty * hl + ny * ht), (cx - tx * hl + nx * ht, cy - ty * hl + ny * ht)]
    return pts, [(nx, ny), (tx, ty)]


def _arc_slices(wall: dict[str, Any]) -> list[Solid] | None:
    """Conservative trapezoid slices covering a round wall's true band; None for straight walls."""
    xs, ys, xe, ye = wall["xStart"], wall["yStart"], wall["xEnd"], wall["yEnd"]
    extent = wall.get("arcExtent")
    if not isinstance(extent, (int, float)) or extent == 0:
        return None
    chord = hypot(xe - xs, ye - ys)
    if chord <= 0:
        return None
    sagitta = (chord / 2) * tan(extent / 4)
    if abs(sagitta) < 1e-9:
        return None
    nx, ny = (ye - ys) / chord, -(xe - xs) / chord
    mx, my = (xs + xe) / 2 + nx * sagitta, (ys + ye) / 2 + ny * sagitta
    radius = (chord * chord / 4 + sagitta * sagitta) / (2 * abs(sagitta))
    sign = 1 if sagitta > 0 else -1
    cx, cy = mx - nx * sign * radius, my - ny * sign * radius
    cross = (xs - cx) * (my - cy) - (ys - cy) * (mx - cx)
    half_thickness = max(0.0, wall.get("thickness") or 0.0) / 2
    outer, inner = radius + half_thickness, max(0.0, radius - half_thickness)
    sweep = abs(extent)
    max_half = acos(1 / (1 + _ARC_TOLERANCE_CM / outer))
    count = min(_MAX_ARC_SLICES, max(1, ceil(sweep / (2 * max_half))))
    direction = 1 if cross >= 0 else -1
    start = atan2(ys - cy, xs - cx)
    step = sweep / count
    half = step / 2
    outer_cut = outer / cos(half)
    slices: list[Solid] = []
    for i in range(count):
        a0 = start + direction * step * i
        a1 = start + direction * step * (i + 1)
        am = (a0 + a1) / 2
        pts = [(cx + inner * cos(a0), cy + inner * sin(a0)), (cx + inner * cos(a1), cy + inner * sin(a1)),
               (cx + outer_cut * cos(a1), cy + outer_cut * sin(a1)), (cx + outer_cut * cos(a0), cy + outer_cut * sin(a0))]
        slices.append((pts, [(cos(am), sin(am)), (-sin(a0), cos(a0)), (-sin(a1), cos(a1))]))
    return slices


def _level_solids(home: dict[str, Any], level_ref: Any) -> list[Solid]:
    solids: list[Solid] = []
    for wall in home.get("walls", []):
        if (wall.get("levelRef") or None) != (level_ref or None):
            continue
        sliced = _arc_slices(wall)
        if sliced is not None:
            solids.extend(sliced)
            continue
        rect = _rect_solid(wall)
        if rect is not None:
            solids.append(rect)
    return solids


def _footprint_overlaps(x: float, y: float, w: float, d: float, angle_deg: float, solid: Solid) -> bool:
    """Separating-axis test: oriented furniture footprint vs. one convex wall solid."""
    pts, axes = solid
    angle = radians(angle_deg or 0)
    ux, uy = cos(angle), sin(angle)
    vx, vy = -uy, ux
    half_w, half_d = w / 2, d / 2
    for ax, ay in (*axes, (ux, uy), (vx, vy)):
        radius_f = abs(ux * ax + uy * ay) * half_w + abs(vx * ax + vy * ay) * half_d
        projected = [px * ax + py * ay for px, py in pts]
        lo, hi = min(projected), max(projected)
        if radius_f + (hi - lo) / 2 - abs(x * ax + y * ay - (lo + hi) / 2) <= _OVERLAP_EPSILON_CM:
            return False
    return True


def _clear(x: float, y: float, w: float, d: float, angle_deg: float, solids: list[Solid]) -> bool:
    reach = hypot(w, d) / 2
    for solid in solids:
        pts = solid[0]
        if all(hypot(px - x, py - y) > reach + hypot(pts[0][0] - pts[2][0], pts[0][1] - pts[2][1]) for px, py in pts):
            continue
        if _footprint_overlaps(x, y, w, d, angle_deg, solid):
            return False
    return True


def _push(x: float, y: float, w: float, d: float, angle_deg: float, solid: Solid) -> tuple[float, float] | None:
    pts, axes = solid
    angle = radians(angle_deg or 0)
    ux, uy = cos(angle), sin(angle)
    vx, vy = -uy, ux
    half_w, half_d = w / 2, d / 2
    best: tuple[float, float, float] | None = None
    for ax, ay in (*axes, (ux, uy), (vx, vy)):
        radius_f = abs(ux * ax + uy * ay) * half_w + abs(vx * ax + vy * ay) * half_d
        projected = [px * ax + py * ay for px, py in pts]
        lo, hi = min(projected), max(projected)
        dist = x * ax + y * ay - (lo + hi) / 2
        depth = radius_f + (hi - lo) / 2 - abs(dist)
        if depth <= _OVERLAP_EPSILON_CM:
            return None
        if best is None or depth < best[2] - 1e-9:
            sgn = -1 if dist < 0 else 1
            best = (ax * sgn * depth, ay * sgn * depth, depth)
    return None if best is None else (best[0], best[1])


def _relax(x: float, y: float, w: float, d: float, angle_deg: float, solids: list[Solid]) -> tuple[float, float] | None:
    for _ in range(_RELAX_PASSES):
        moved = False
        for solid in solids:
            push = _push(x, y, w, d, angle_deg, solid)
            if push is not None:
                x, y = x + push[0], y + push[1]
                moved = True
        if not moved:
            return x, y
    return None


def _room_for(item: dict[str, Any], rooms: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The smallest same-level room whose polygon contains the piece's centre."""
    inside = [room for room in rooms
              if (room.get("levelRef") or None) == (item.get("levelRef") or None)
              and len(room.get("points", [])) >= 3 and _inside((item["x"], item["y"]), room["points"])]
    return min(inside, key=lambda room: _area(room["points"])) if inside else None


def _fits_in_room(item: dict[str, Any], room: dict[str, Any], solids: list[Solid]) -> bool:
    """Whether the footprint can sit clear of every wall somewhere inside the room."""
    w, d, angle = item["width"], item["depth"], item.get("angleDeg") or 0
    if _clear(item["x"], item["y"], w, d, angle, solids):
        return True
    points = room["points"]
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    seeds = [(item["x"], item["y"])]
    for i in range(_SEED_GRID):
        for j in range(_SEED_GRID):
            seeds.append((min(xs) + (i + 0.5) / _SEED_GRID * (max(xs) - min(xs)),
                          min(ys) + (j + 0.5) / _SEED_GRID * (max(ys) - min(ys))))
    seeds.append((sum(xs) / len(xs), sum(ys) / len(ys)))
    for sx, sy in seeds:
        if not _inside((sx, sy), points):
            continue
        settled = _relax(sx, sy, w, d, angle, solids)
        if settled is not None and _inside(settled, points):
            return True
    return False


def _fmt_cm(value: float) -> str:
    return str(int(round(value * 10)) / 10).removesuffix(".0")


def furniture_wall_overlaps(home: dict[str, Any]) -> list[tuple[Any, Any]]:
    """(furniture id, wall id) pairs where a non-opening piece penetrates a wall on its own level."""
    pairs: list[tuple[Any, Any]] = []
    for item in home.get("furniture", []):
        if item.get("doorOrWindow") or not all(isinstance(item.get(key), (int, float)) for key in ("x", "y", "width", "depth")):
            continue
        for wall in home.get("walls", []):
            if (wall.get("levelRef") or None) != (item.get("levelRef") or None):
                continue
            solids = _arc_slices(wall) or ([rect] if (rect := _rect_solid(wall)) else [])
            if not _clear(item["x"], item["y"], item["width"], item["depth"], item.get("angleDeg") or 0, solids):
                pairs.append((item.get("id"), wall.get("id")))
    return pairs


def furniture_too_large(home: dict[str, Any]) -> list[str]:
    """Messages (same wording as the app's FurnitureTooLargeError) for pieces that cannot fit the room they are in."""
    messages: list[str] = []
    rooms = home.get("rooms", [])
    cache: dict[Any, list[Solid]] = {}
    for item in home.get("furniture", []):
        if item.get("doorOrWindow") or not all(isinstance(item.get(key), (int, float)) for key in ("x", "y", "width", "depth")):
            continue
        room = _room_for(item, rooms)
        if room is None:
            continue
        level = item.get("levelRef") or None
        if level not in cache:
            cache[level] = _level_solids(home, level)
        if not cache[level] or _fits_in_room(item, room, cache[level]):
            continue
        xs, ys = [p[0] for p in room["points"]], [p[1] for p in room["points"]]
        room_label = f'room "{room["name"]}"' if room.get("name") else f"room {room.get('id')}"
        messages.append(
            f'"{item.get("name")}" ({_fmt_cm(item["width"])} x {_fmt_cm(item["depth"])} cm) is too large for {room_label} '
            f"(about {_fmt_cm(max(xs) - min(xs))} x {_fmt_cm(max(ys) - min(ys))} cm): it cannot fit inside the room's walls."
        )
    return messages


def analyze_home(home: dict[str, Any]) -> dict[str, Any]:
    walls = home.get("walls", [])
    rooms = home.get("rooms", [])
    furniture = home.get("furniture", [])
    roofs = home.get("roofs", [])
    points: list[tuple[float, float]] = []
    for wall in walls:
        points.extend([(wall["xStart"], wall["yStart"]), (wall["xEnd"], wall["yEnd"])])
    for item in rooms + roofs:
        points.extend((p[0], p[1]) for p in item.get("points", []))
    points.extend((item["x"], item["y"]) for item in furniture)

    room_rows = []
    for room in rooms:
        polygon = room.get("points", [])
        room_rows.append({
            "id": room.get("id"),
            "name": room.get("name"),
            "areaSqM": round(_area(polygon) / 10000, 2) if len(polygon) >= 3 else 0,
            "bounds": _bounds([(p[0], p[1]) for p in polygon]),
            "levelRef": room.get("levelRef"),
        })

    furniture_rows = []
    for item in furniture:
        room_id = next((room.get("id") for room in rooms if _inside((item["x"], item["y"]), room.get("points", []))), None)
        furniture_rows.append({
            "id": item.get("id"), "name": item.get("name"), "catalogId": item.get("catalogId"),
            "x": item.get("x"), "y": item.get("y"), "roomId": room_id,
            "levelRef": item.get("levelRef"),
        })

    warnings: list[str] = []
    if not walls:
        warnings.append("scene has no walls")
    if not rooms:
        warnings.append("scene has no rooms")
    for kind, items in (("wall", walls), ("room", rooms), ("furniture", furniture)):
        id_counts: dict[Any, int] = defaultdict(int)
        for item in items:
            if item.get("id") is not None:
                id_counts[item["id"]] += 1
        warnings.extend(f"duplicate {kind} id: {item_id}" for item_id, count in id_counts.items() if count > 1)
    for row in room_rows:
        if row["areaSqM"] <= 0:
            warnings.append(f"room {row['id']} has zero area")
    for room in rooms:
        polygon = room.get("points", [])
        if len(polygon) >= 4 and _self_intersects(polygon):
            warnings.append(f"room {room.get('id')} polygon is self-intersecting")
    for row in furniture_rows:
        if row["roomId"] is None and not any(item.get("doorOrWindow") for item in furniture if item.get("id") == row["id"]):
            warnings.append(f"furniture {row['id']} is outside every room")
    warnings.extend(f"furniture {item_id} overlaps wall {wall_id}" for item_id, wall_id in furniture_wall_overlaps(home))
    warnings.extend(furniture_too_large(home))
    for i in range(len(rooms)):
        for j in range(i + 1, len(rooms)):
            if _rooms_overlap(rooms[i].get("points", []), rooms[j].get("points", [])):
                warnings.append(f"rooms {rooms[i].get('id')} and {rooms[j].get('id')} overlap")

    wall_nodes: dict[tuple[int, int], int] = defaultdict(int)
    for wall in walls:
        for x, y in ((wall["xStart"], wall["yStart"]), (wall["xEnd"], wall["yEnd"])):
            wall_nodes[(round(x), round(y))] += 1
    loose = sum(1 for count in wall_nodes.values() if count == 1)
    if loose:
        warnings.append(f"{loose} wall endpoints are not connected to another wall")

    opening_refs = [item.get("wallRef") for item in furniture if item.get("doorOrWindow")]
    wall_ids = {wall.get("id") for wall in walls}
    missing_openings = [ref for ref in opening_refs if ref not in wall_ids]
    if missing_openings:
        warnings.append(f"{len(missing_openings)} door/window references a missing wall")

    return {
        "schemaVersion": 1,
        "counts": {key: len(home.get(key, [])) for key in (
            "levels", "walls", "rooms", "polylines", "furniture", "dimensionLines", "labels", "roofs"
        )},
        "bounds": _bounds(points),
        "levels": [{"id": level.get("id"), "name": level.get("name"), "elevation": level.get("elevation"),
                    "height": level.get("height")} for level in home.get("levels", [])],
        "rooms": room_rows,
        "furniture": furniture_rows,
        "openings": [{"id": item.get("id"), "kind": "door" if "door" in str(item.get("name", "")).lower() else "window",
                      "wallRef": item.get("wallRef"), "x": item.get("x"), "y": item.get("y")} for item in furniture if item.get("doorOrWindow")],
        "warnings": warnings,
    }


def validate_home(home: dict[str, Any]) -> dict[str, Any]:
    summary = analyze_home(home)
    errors = [
        warning for warning in summary["warnings"]
        if warning.startswith("scene has no ")
        or warning.startswith("duplicate ")
        or " is self-intersecting" in warning
        or (warning.startswith("furniture ") and " overlaps wall " in warning)
        or " is too large for room " in warning
    ]
    return {"valid": not errors, "errors": errors, "warnings": summary["warnings"], "summary": summary}
