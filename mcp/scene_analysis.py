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
    for row in room_rows:
        if row["areaSqM"] <= 0:
            warnings.append(f"room {row['id']} has zero area")
    for row in furniture_rows:
        if row["roomId"] is None and not any(item.get("doorOrWindow") for item in furniture if item.get("id") == row["id"]):
            warnings.append(f"furniture {row['id']} is outside every room")

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
    errors = [warning for warning in summary["warnings"] if warning.startswith("scene has no ")]
    return {"valid": not errors, "errors": errors, "warnings": summary["warnings"], "summary": summary}
