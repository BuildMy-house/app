"""Small, JSON-safe scene checks for agents that do not need pixels."""

from __future__ import annotations

from collections import defaultdict
from math import hypot
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
    ]
    return {"valid": not errors, "errors": errors, "warnings": summary["warnings"], "summary": summary}
