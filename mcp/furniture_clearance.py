"""Furniture-vs-wall clearance, ported 1:1 from the app so the MCP bridge and the
app agree on what "overlaps a wall" and "too large for its room" mean.

Mirrors src/plan/wall-solids.ts, src/plan/furniture-room-fit.ts, src/plan/wall-height.ts
and findClearanceViolations in src/core/furniture-clearance.ts. A fixed corpus
(tests/fixtures/furniture-clearance-corpus.json) is checked against both
implementations (src/core/furniture-clearance-parity.test.ts and
mcp/test_clearance_parity.py), so a change on one side that is not made on the
other fails a test. Keep the two in step: same constants, same algorithms.

The push-out for a round wall is analytic (arc_push), exactly like the app: the
exact minimum translation outside the outer circle, inside the inner circle or
past an end of the arc. A slice-by-slice push would shove a piece along the curve
and could report a piece as too large when it is not.
"""

from __future__ import annotations

from math import acos, atan2, ceil, cos, floor, hypot, inf, isfinite, pi, radians, sin, sqrt, tan
from typing import Any

DEFAULT_WALL_HEIGHT_CM = 250
ARC_TOLERANCE_CM = 0.005
MAX_ARC_SLICES = 4096
OVERLAP_EPSILON_CM = 1e-6
RELAX_PASSES = 64
SEARCH_STEP_CM = 5
SEARCH_DIRECTIONS = 32
SEED_GRID = 5

Point = tuple[float, float]
# (corner points flattened x0,y0,..., axes)
Solid = tuple[list[float], list[tuple[float, float]]]
Footprint = tuple[float, float, float, float, float, float]  # x, y, ux, uy, halfW, halfD


def footprint_at(x: float, y: float, width: float, depth: float, angle_deg: float) -> Footprint:
    rad = angle_deg * pi / 180
    return (x, y, cos(rad), sin(rad), width / 2, depth / 2)


def wall_top_cm(wall: dict[str, Any]) -> float:
    start = wall.get("height")
    start = DEFAULT_WALL_HEIGHT_CM if start is None else start
    end = wall.get("heightAtEnd")
    end = start if end is None else end
    return max(start, end)


def walls_blocking_at(walls: list[dict[str, Any]], elevation_cm: Any) -> list[dict[str, Any]]:
    if not isinstance(elevation_cm, (int, float)) or isinstance(elevation_cm, bool) or not isfinite(elevation_cm):
        return list(walls)
    return [wall for wall in walls if wall_top_cm(wall) > elevation_cm]


def _rect_solid(wall: dict[str, Any]) -> Solid | None:
    dx, dy = wall["xEnd"] - wall["xStart"], wall["yEnd"] - wall["yStart"]
    length = hypot(dx, dy)
    if not length > 0:
        return None
    tx, ty = dx / length, dy / length
    nx, ny = -ty, tx
    cx, cy = (wall["xStart"] + wall["xEnd"]) / 2, (wall["yStart"] + wall["yEnd"]) / 2
    hl = length / 2
    ht = max(0.0, wall.get("thickness") or 0.0) / 2
    pts = [cx - tx * hl - nx * ht, cy - ty * hl - ny * ht, cx + tx * hl - nx * ht, cy + ty * hl - ny * ht,
           cx + tx * hl + nx * ht, cy + ty * hl + ny * ht, cx - tx * hl + nx * ht, cy - ty * hl + ny * ht]
    return pts, [(nx, ny), (tx, ty)]


class Arc:
    __slots__ = ("cx", "cy", "radius", "inner_r", "outer_r", "start", "dir", "sweep", "slices", "half")

    def __init__(self, cx, cy, radius, inner_r, outer_r, start, direction, sweep, slices, half):
        self.cx, self.cy, self.radius, self.inner_r, self.outer_r = cx, cy, radius, inner_r, outer_r
        self.start, self.dir, self.sweep, self.slices, self.half = start, direction, sweep, slices, half


def arc_geometry(wall: dict[str, Any]) -> Arc | None:
    extent = wall.get("arcExtent")
    if not isinstance(extent, (int, float)) or isinstance(extent, bool) or not isfinite(extent) or extent == 0:
        return None
    dx, dy = wall["xEnd"] - wall["xStart"], wall["yEnd"] - wall["yStart"]
    chord = hypot(dx, dy)
    if not chord > 0:
        return None
    sagitta = (chord / 2) * tan(extent / 4)
    if not isfinite(sagitta) or abs(sagitta) < 1e-9:
        return None
    nx, ny = dy / chord, -dx / chord
    mx, my = (wall["xStart"] + wall["xEnd"]) / 2 + nx * sagitta, (wall["yStart"] + wall["yEnd"]) / 2 + ny * sagitta
    radius = (chord * chord / 4 + sagitta * sagitta) / (2 * abs(sagitta))
    sign = 1 if sagitta > 0 else -1
    cx, cy = mx - nx * sign * radius, my - ny * sign * radius
    cross = (wall["xStart"] - cx) * (my - cy) - (wall["yStart"] - cy) * (mx - cx)
    half_thickness = max(0.0, wall.get("thickness") or 0.0) / 2
    outer_r = radius + half_thickness
    sweep = abs(extent)
    max_half = acos(1 / (1 + ARC_TOLERANCE_CM / outer_r))
    slices = min(MAX_ARC_SLICES, max(1, ceil(sweep / (2 * max_half))))
    return Arc(cx, cy, radius, max(0.0, radius - half_thickness), outer_r,
               atan2(wall["yStart"] - cy, wall["xStart"] - cx), 1 if cross >= 0 else -1, sweep, slices, sweep / (2 * slices))


def _arc_slice(arc: Arc, i: int) -> Solid:
    step = arc.sweep / arc.slices
    a0 = arc.start + arc.dir * step * i
    a1 = arc.start + arc.dir * step * (i + 1)
    am = (a0 + a1) / 2
    outer_cut = arc.outer_r / cos(arc.half)

    def point(angle: float, r: float) -> tuple[float, float]:
        return arc.cx + r * cos(angle), arc.cy + r * sin(angle)

    ix0, iy0 = point(a0, arc.inner_r)
    ix1, iy1 = point(a1, arc.inner_r)
    ox1, oy1 = point(a1, outer_cut)
    ox0, oy0 = point(a0, outer_cut)
    return [ix0, iy0, ix1, iy1, ox1, oy1, ox0, oy0], [(cos(am), sin(am)), (-sin(a0), cos(a0)), (-sin(a1), cos(a1))]


def _wrap_pi(angle: float) -> float:
    a = _js_mod(angle, 2 * pi)
    if a > pi:
        a -= 2 * pi
    if a <= -pi:
        a += 2 * pi
    return a


def _js_mod(a: float, b: float) -> float:
    """JavaScript's % (sign of the dividend), not Python's."""
    r = a % b if a >= 0 else -((-a) % b)
    return r


def _corners(f: Footprint) -> list[tuple[float, float]]:
    x, y, ux, uy, hw, hd = f
    vx, vy = -uy, ux
    out = []
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        out.append((x + ux * hw * sx + vx * hd * sy, y + uy * hw * sx + vy * hd * sy))
    return out


def _arc_slices_near(arc: Arc, f: Footprint) -> list[Solid]:
    x, y, ux, uy, hw, hd = f
    cs = _corners(f)
    d_max = 0.0
    for cx_, cy_ in cs:
        d_max = max(d_max, hypot(cx_ - arc.cx, cy_ - arc.cy))
    cos_half = cos(arc.half)
    if d_max < arc.inner_r * cos_half:
        return []
    rx, ry = arc.cx - x, arc.cy - y
    lx, ly = abs(rx * ux + ry * uy), abs(-rx * uy + ry * ux)
    d_min = hypot(max(0.0, lx - hw), max(0.0, ly - hd))
    if d_min > arc.outer_r / cos_half:
        return []
    step = arc.sweep / arc.slices
    if d_min == 0:
        return [_arc_slice(arc, i) for i in range(arc.slices)]
    ref = atan2(y - arc.cy, x - arc.cx)
    lo = hi = 0.0
    for cx_, cy_ in cs:
        delta = _wrap_pi(atan2(cy_ - arc.cy, cx_ - arc.cx) - ref)
        lo, hi = min(lo, delta), max(hi, delta)

    def along(angle: float) -> float:
        a = _js_mod(arc.dir * (angle - arc.start), 2 * pi)
        return a + 2 * pi if a < 0 else a

    frm = along(ref + (lo if arc.dir > 0 else hi))
    width = hi - lo
    ranges = [(frm, frm + width)] if frm + width <= 2 * pi else [(frm, 2 * pi), (0.0, frm + width - 2 * pi)]
    out: list[Solid] = []
    for a, b in ranges:
        if a > arc.sweep:
            continue
        first = max(0, floor(a / step) - 1)
        last = min(arc.slices - 1, floor(b / step) + 1)
        for i in range(first, last + 1):
            out.append(_arc_slice(arc, i))
    return out


def _solid_push(f: Footprint, solid: Solid) -> tuple[float, float] | None:
    x, y, ux, uy, hw, hd = f
    vx, vy = -uy, ux
    pts, axes = solid
    best: tuple[float, float, float] | None = None
    for ax, ay in (*axes, (ux, uy), (vx, vy)):
        rf = abs(ux * ax + uy * ay) * hw + abs(vx * ax + vy * ay) * hd
        lo, hi = inf, -inf
        for i in range(0, 8, 2):
            p = pts[i] * ax + pts[i + 1] * ay
            lo, hi = min(lo, p), max(hi, p)
        dist = x * ax + y * ay - (lo + hi) / 2
        depth = rf + (hi - lo) / 2 - abs(dist)
        if depth <= OVERLAP_EPSILON_CM:
            return None
        if best is None or depth < best[2] - 1e-9:
            sign = -1 if dist < 0 else 1
            best = (ax * sign * depth, ay * sign * depth, depth)
    return None if best is None else (best[0], best[1])


def _overlaps_slices(arc: Arc, f: Footprint) -> bool:
    return any(_solid_push(f, s) is not None for s in _arc_slices_near(arc, f))


def _outward_push(f: Footprint, cx: float, cy: float, radius: float) -> tuple[float, float] | None:
    x, y, ux, uy, hw, hd = f
    vx, vy = -uy, ux
    lx = (cx - x) * ux + (cy - y) * uy
    ly = (cx - x) * vx + (cy - y) * vy
    ex, ey = abs(lx) - hw, abs(ly) - hd
    if ex > 0 or ey > 0:
        dist = hypot(max(ex, 0.0), max(ey, 0.0))
        if dist >= radius:
            return None
        px = max(-hw, min(hw, lx)) - lx
        py = max(-hd, min(hd, ly)) - ly
        nx, ny = (ux * px + vx * py) / dist, (uy * px + vy * py) / dist
        return nx * (radius - dist), ny * (radius - dist)
    slack_x, slack_y = hw - abs(lx), hd - abs(ly)
    if slack_x <= slack_y:
        s = -_sign(lx or 1) * (slack_x + radius)
        return ux * s, uy * s
    s = -_sign(ly or 1) * (slack_y + radius)
    return vx * s, vy * s


def _sign(v: float) -> int:
    return 1 if v > 0 else -1 if v < 0 else 0


def _inward_push(f: Footprint, cx: float, cy: float, radius: float) -> tuple[float, float] | None:
    if not radius > 0:
        return None
    centres = [(cx - x, cy - y) for x, y in _corners(f)]
    slack = 1e-9
    best: tuple[float, float, float] | None = None

    def consider(tx: float, ty: float) -> None:
        nonlocal best
        if not all(hypot(tx - px, ty - py) <= radius + slack for px, py in centres):
            return
        norm = hypot(tx, ty)
        if best is None or norm < best[2]:
            best = (tx, ty, norm)

    for px, py in centres:
        dist = hypot(px, py)
        if dist > radius:
            consider(px * (dist - radius) / dist, py * (dist - radius) / dist)
    for k in range(4):
        for l in range(k + 1, 4):
            ax, ay = centres[k]
            bx, by = centres[l]
            d = hypot(bx - ax, by - ay)
            if d == 0 or d > 2 * radius:
                continue
            h = sqrt(max(0.0, radius * radius - (d / 2) * (d / 2)))
            mx, my = (ax + bx) / 2, (ay + by) / 2
            consider(mx - ((by - ay) / d) * h, my + ((bx - ax) / d) * h)
            consider(mx + ((by - ay) / d) * h, my - ((bx - ax) / d) * h)
    return None if best is None else (best[0], best[1])


def _arc_push(f: Footprint, arc: Arc) -> tuple[float, float] | None:
    if not _overlaps_slices(arc, f):
        return None
    cos_half = cos(arc.half)
    candidates: list[tuple[float, float]] = []
    outward = _outward_push(f, arc.cx, arc.cy, arc.outer_r / cos_half)
    if outward:
        candidates.append(outward)
    inward = _inward_push(f, arc.cx, arc.cy, arc.inner_r * cos_half)
    if inward:
        candidates.append(inward)
    x, y, ux, uy, hw, hd = f
    for end in (0, 1):
        angle = arc.start + arc.dir * arc.sweep * end
        sign = -arc.dir if end == 0 else arc.dir
        ex, ey = -sin(angle) * sign, cos(angle) * sign
        lowest = min((cx_ - arc.cx) * ex + (cy_ - arc.cy) * ey for cx_, cy_ in _corners(f))
        if lowest >= 0:
            continue
        moved = footprint_at(x - ex * lowest, y - ey * lowest, hw * 2, hd * 2, atan2(uy, ux) * 180 / pi)
        if not _overlaps_slices(arc, moved):
            candidates.append((-ex * lowest, -ey * lowest))
    best: tuple[float, float] | None = None
    for c in candidates:
        if best is None or hypot(*c) < hypot(*best):
            best = c
    return best


class WallSolids:
    __slots__ = ("rects", "arcs")

    def __init__(self, rects: list[Solid], arcs: list[Arc]):
        self.rects, self.arcs = rects, arcs

    def empty(self) -> bool:
        return not self.rects and not self.arcs


def wall_solids(walls: list[dict[str, Any]]) -> WallSolids:
    rects: list[Solid] = []
    arcs: list[Arc] = []
    for wall in walls:
        arc = arc_geometry(wall)
        if arc:
            arcs.append(arc)
            continue
        rect = _rect_solid(wall)
        if rect:
            rects.append(rect)
    return WallSolids(rects, arcs)


def _solids_near(solids: WallSolids, f: Footprint) -> list[Solid]:
    if not solids.arcs:
        return solids.rects
    near = list(solids.rects)
    for arc in solids.arcs:
        near.extend(_arc_slices_near(arc, f))
    return near


def overlaps_any_solid(f: Footprint, solids: WallSolids) -> bool:
    return any(_solid_push(f, s) is not None for s in _solids_near(solids, f))


def settle(solids: WallSolids, x: float, y: float, w: float, d: float, angle_deg: float) -> tuple[float, float, bool]:
    if not all(isfinite(v) for v in (x, y, w, d, angle_deg)) or solids.empty():
        return x, y, True
    for _ in range(RELAX_PASSES):
        moved = False
        for rect in solids.rects:
            push = _solid_push(footprint_at(x, y, w, d, angle_deg), rect)
            if push:
                x, y, moved = x + push[0], y + push[1], True
        for arc in solids.arcs:
            push = _arc_push(footprint_at(x, y, w, d, angle_deg), arc)
            if push:
                x, y, moved = x + push[0], y + push[1], True
        if not moved:
            return x, y, True
    return x, y, not overlaps_any_solid(footprint_at(x, y, w, d, angle_deg), solids)


def nearest_free_spot(solids: WallSolids, x: float, y: float, w: float, d: float, angle_deg: float) -> tuple[float, float]:
    reach = 0.0
    for pts, _ in solids.rects:
        for i in range(0, 8, 2):
            reach = max(reach, hypot(pts[i] - x, pts[i + 1] - y))
    for arc in solids.arcs:
        reach = max(reach, hypot(arc.cx - x, arc.cy - y) + arc.outer_r / cos(arc.half))
    max_radius = reach + hypot(w, d) + SEARCH_STEP_CM
    radius = SEARCH_STEP_CM
    while radius <= max_radius + SEARCH_STEP_CM:
        for i in range(SEARCH_DIRECTIONS):
            theta = 2 * pi * i / SEARCH_DIRECTIONS
            px, py = x + cos(theta) * radius, y + sin(theta) * radius
            if not overlaps_any_solid(footprint_at(px, py, w, d, angle_deg), solids):
                return px, py
        radius += SEARCH_STEP_CM
    return x, y


# --- rooms (furniture-room-fit.ts) -------------------------------------------

Polygon = list[list[float]]


def inside_polygon(x: float, y: float, points: Polygon) -> bool:
    inside = False
    j = len(points) - 1
    for i in range(len(points)):
        xi, yi = points[i]
        xj, yj = points[j]
        if (yi > y) != (yj > y) and x < ((xj - xi) * (y - yi)) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def polygon_area(points: Polygon) -> float:
    total = 0.0
    j = len(points) - 1
    for i in range(len(points)):
        total += points[j][0] * points[i][1] - points[i][0] * points[j][1]
        j = i
    return abs(total) / 2


def _distance_to_polygon(x: float, y: float, points: Polygon) -> float:
    if inside_polygon(x, y, points):
        return 0.0
    best = inf
    j = len(points) - 1
    for i in range(len(points)):
        ax, ay = points[j]
        bx, by = points[i]
        dx, dy = bx - ax, by - ay
        length_sq = dx * dx + dy * dy
        t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / length_sq)) if length_sq > 0 else 0.0
        best = min(best, hypot(x - (ax + t * dx), y - (ay + t * dy)))
        j = i
    return best


def bounds_of(points: Polygon) -> tuple[float, float, float, float]:
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return min(xs), max(xs), min(ys), max(ys)


def _seeds_for(points: Polygon, origin: Point) -> list[Point]:
    min_x, max_x, min_y, max_y = bounds_of(points)
    seeds: list[Point] = [origin]
    for i in range(SEED_GRID):
        for j in range(SEED_GRID):
            p = (min_x + ((i + 0.5) / SEED_GRID) * (max_x - min_x), min_y + ((j + 0.5) / SEED_GRID) * (max_y - min_y))
            if inside_polygon(p[0], p[1], points):
                seeds.append(p)
    n = len(points)
    centroid = (sum(p[0] for p in points) / n, sum(p[1] for p in points) / n)
    if inside_polygon(centroid[0], centroid[1], points):
        seeds.append(centroid)
    return seeds


def _fit_in_room(points: Polygon, solids: WallSolids, origin: Point, w: float, d: float, angle_deg: float) -> Point | None:
    best: Point | None = None
    best_distance = inf
    for sx, sy in _seeds_for(points, origin):
        x, y, ok = settle(solids, sx, sy, w, d, angle_deg)
        if not ok or not inside_polygon(x, y, points):
            continue
        distance = hypot(x - origin[0], y - origin[1])
        if distance < best_distance:
            best, best_distance = (x, y), distance
    return best


def resolve_footprint(solids: WallSolids, rooms: list[dict[str, Any]], origin: Point, w: float, d: float, angle_deg: float):
    """(True, x, y) when the piece fits (possibly moved), else (False, room, room_width, room_depth)."""
    ox, oy = origin
    rx, ry, settled = settle(solids, ox, oy, w, d, angle_deg)
    if settled and rx == ox and ry == oy:
        return True, ox, oy
    candidates = [room for room in rooms if inside_polygon(ox, oy, room["points"])]
    if settled:
        if not candidates or any(inside_polygon(rx, ry, room["points"]) for room in candidates):
            return True, rx, ry
    elif not candidates:
        reach = hypot(w, d) / 2
        near = sorted(((_distance_to_polygon(ox, oy, room["points"]), index, room) for index, room in enumerate(rooms)),
                      key=lambda t: (t[0], t[1]))
        candidates = [room for dist, _, room in near if dist <= reach][:1]
    if not candidates:
        fx, fy = nearest_free_spot(solids, ox, oy, w, d, angle_deg)
        return True, fx, fy
    candidates = sorted(candidates, key=lambda room: polygon_area(room["points"]))
    best: Point | None = None
    best_distance = inf
    for room in candidates:
        fit = _fit_in_room(room["points"], solids, origin, w, d, angle_deg)
        if not fit:
            continue
        distance = hypot(fit[0] - ox, fit[1] - oy)
        if distance < best_distance:
            best, best_distance = fit, distance
    if best:
        return True, best[0], best[1]
    min_x, max_x, min_y, max_y = bounds_of(candidates[0]["points"])
    return False, candidates[0], max_x - min_x, max_y - min_y


# --- whole-home verdicts (findClearanceViolations in furniture-clearance.ts) ----

def _fmt(cm: float) -> str:
    return str(int(round(cm * 10)) / 10).removesuffix(".0")


def too_large_message(item: dict[str, Any], room: dict[str, Any], room_w: float, room_d: float) -> str:
    label = f'room "{room["name"]}"' if room.get("name") else f"room {room.get('id')}"
    return (f'"{item.get("name")}" ({_fmt(item["width"])} x {_fmt(item["depth"])} cm) is too large for {label} '
            f"(about {_fmt(room_w)} x {_fmt(room_d)} cm): it cannot fit inside the room's walls.")


def _checkable(item: dict[str, Any]) -> bool:
    return not item.get("doorOrWindow") and all(
        isinstance(item.get(key), (int, float)) and not isinstance(item.get(key), bool) for key in ("x", "y", "width", "depth"))


def find_clearance_violations(home: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """overlaps: one {furnitureId, wallId} per wall a piece penetrates (a piece
    hung above a wall's top does not count); oversize: one entry per piece that
    cannot fit anywhere inside the room it is in."""
    overlaps: list[dict[str, Any]] = []
    oversize: list[dict[str, Any]] = []
    walls_by_level: dict[Any, list[dict[str, Any]]] = {}
    for wall in home.get("walls", []):
        walls_by_level.setdefault(wall.get("levelRef") or None, []).append(wall)
    rooms_by_level: dict[Any, list[dict[str, Any]]] = {}
    for room in home.get("rooms", []):
        if len(room.get("points", [])) >= 3:
            rooms_by_level.setdefault(room.get("levelRef") or None, []).append(room)
    solids_cache: dict[tuple[Any, int], WallSolids] = {}
    for item in home.get("furniture", []):
        if not _checkable(item):
            continue
        level = item.get("levelRef") or None
        elevation = item.get("elevation")
        blocking = walls_blocking_at(walls_by_level.get(level, []), elevation)
        if not blocking:
            continue
        angle = item.get("angleDeg") or 0
        f = footprint_at(item["x"], item["y"], item["width"], item["depth"], angle)
        for wall in blocking:
            if overlaps_any_solid(f, wall_solids([wall])):
                overlaps.append({"furnitureId": item.get("id"), "wallId": wall.get("id")})
        key = (level, len(blocking))
        if key not in solids_cache:
            solids_cache[key] = wall_solids(blocking)
        result = resolve_footprint(solids_cache[key], rooms_by_level.get(level, []), (item["x"], item["y"]), item["width"], item["depth"], angle)
        if not result[0]:
            _, room, room_w, room_d = result
            oversize.append({"furnitureId": item.get("id"), "roomId": room.get("id"),
                             "message": too_large_message(item, room, room_w, room_d)})
    return {"overlaps": overlaps, "oversize": oversize}
