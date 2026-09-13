"""MockAdapter: deterministic in-process reference implementation of the
automation protocol v1. Lets the harness (orchestrator, comparators,
reporting) be developed and verified before Tracks A/B land.

Semantics intentionally mirror Sweet Home 3D plan behaviour at reference
fidelity: wall chaining with double-click close + room auto-detection on a
closed loop, escape cancels, explicit magnetism snapping to nearby wall ends,
selection hit-testing, undo/redo of home-model mutations only (selection and
camera changes are not undoable), paste offsetting like SH3D.

Geometry constants are mock-local; cross-app equivalence never relies on them.
"""

from __future__ import annotations

import base64
import copy
import io
import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

from eq.adapters.base import Adapter, AdapterError
from eq.dsl.schema import COMMANDS

EPS = 1e-9
SNAP_DISTANCE = 5.0
WALL_THICKNESS = 10.0
WALL_HEIGHT = 250.0

CAMERA_TOP = {"x": 0.0, "y": 0.0, "z": 1010.0, "yawDeg": -90.0, "pitchDeg": -90.0, "fovDeg": 63.0}
CAMERA_OBSERVER = {"x": 0.0, "y": 0.0, "z": 170.0, "yawDeg": 315.0, "pitchDeg": 11.25, "fovDeg": 63.0}

COLLECTIONS = ("walls", "rooms", "furniture", "dimensionLines", "labels")

CATALOG: list[dict[str, Any]] = [
    {"catalogId": "chair", "name": "Chair", "width": 46.0, "depth": 48.0, "height": 106.0, "doorOrWindow": False},
    {"catalogId": "table", "name": "Table", "width": 160.0, "depth": 90.0, "height": 75.0, "doorOrWindow": False},
    {"catalogId": "sofa", "name": "Sofa", "width": 190.0, "depth": 90.0, "height": 85.0, "doorOrWindow": False},
    {"catalogId": "door", "name": "Door", "width": 80.0, "depth": 10.0, "height": 200.0, "doorOrWindow": True},
    {"catalogId": "window", "name": "Window", "width": 100.0, "depth": 8.0, "height": 120.0, "doorOrWindow": True},
]

PASTE_OFFSET = 20.0


def _empty_state() -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "name": None,
        "levels": [
            {
                "id": "level-1",
                "name": "Level 0",
                "elevation": 0.0,
                "floorThickness": 0.0,
                "height": WALL_HEIGHT,
                "visible": True,
                "viewable": True,
            }
        ],
        "walls": [],
        "rooms": [],
        "furniture": [],
        "roofs": [],
        "dimensionLines": [],
        "labels": [],
        "compass": None,
        "cameras": {
            "top": dict(CAMERA_TOP),
            "observer": dict(CAMERA_OBSERVER),
        },
        "environment": {},
        "selection": [],
        "activeTool": "selection",
        "capabilities": {"canUndo": False, "canRedo": False},
    }


def _round3(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 3)
    if isinstance(value, list):
        return [_round3(v) for v in value]
    if isinstance(value, dict):
        return {k: _round3(v) for k, v in value.items()}
    return value


class MockAdapter(Adapter):
    app = "mock"

    def __init__(self, name: str):
        self.name = name
        self._state = _empty_state()
        self._undo_stack: list[dict[str, Any]] = []
        self._redo_stack: list[dict[str, Any]] = []
        self._counters: dict[str, int] = defaultdict(int)
        self._chain: list[tuple[float, float]] = []
        self._magnetism = True
        self._scale = 1.0
        self._view = "plan"
        self._clipboard: list[tuple[str, dict[str, Any]]] = []
        self._last_mouse: tuple[float, float] | None = None

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    async def request(self, command: str, params: dict[str, Any] | None = None) -> Any:
        params = params or {}
        if command not in COMMANDS:
            raise AdapterError(f"unknown command '{command}'", "UNKNOWN_COMMAND")
        handler = getattr(self, f"_cmd_{command}", None)
        if handler is None:
            raise AdapterError(f"command '{command}' not implemented by mock", "NOT_IMPLEMENTED")
        return handler(params)

    # ---- helpers ----

    def _next_id(self, prefix: str) -> str:
        self._counters[prefix] += 1
        return f"{prefix}-{self._counters[prefix]}"

    def _mutate(self) -> None:
        self._undo_stack.append(copy.deepcopy(self._state))
        self._redo_stack.clear()
        self._refresh_capabilities()

    def _refresh_capabilities(self) -> None:
        self._state["capabilities"] = {
            "canUndo": bool(self._undo_stack),
            "canRedo": bool(self._redo_stack),
        }

    def _snap(self, x: float, y: float) -> tuple[float, float]:
        if not self._magnetism:
            return (round(x, 3), round(y, 3))
        best: tuple[float, float] | None = None
        best_d = SNAP_DISTANCE
        for wall in self._state["walls"]:
            for px, py in ((wall["xStart"], wall["yStart"]), (wall["xEnd"], wall["yEnd"])):
                d = math.hypot(x - px, y - py)
                if d <= best_d + EPS:
                    best_d = d
                    best = (px, py)
        return best if best is not None else (round(x, 3), round(y, 3))

    @staticmethod
    def _dist_point_segment(px, py, ax, ay, bx, by) -> float:
        abx, aby = bx - ax, by - ay
        apx, apy = px - ax, py - ay
        length2 = abx * abx + aby * aby
        if length2 < EPS:
            return math.hypot(apx, apy)
        t = max(0.0, min(1.0, (apx * abx + apy * aby) / length2))
        return math.hypot(apx - t * abx, apy - t * aby)

    @staticmethod
    def _point_in_polygon(px, py, points) -> bool:
        inside = False
        n = len(points)
        for i in range(n):
            x1, y1 = points[i][0], points[i][1]
            x2, y2 = points[(i + 1) % n][0], points[(i + 1) % n][1]
            if (y1 > py) != (y2 > py):
                xin = (x2 - x1) * (py - y1) / (y2 - y1) + x1
                if px < xin:
                    inside = not inside
        return inside

    def _hit_test(self, x: float, y: float) -> str | None:
        st = self._state
        for label in st["labels"]:
            if math.hypot(label["x"] - x, label["y"] - y) <= 10.0:
                return label["id"]
        for line in st["dimensionLines"]:
            d = min(
                self._dist_point_segment(x, y, line["xStart"], line["yStart"], line["xEnd"], line["yEnd"]),
                self._dist_point_segment(x, y, line["xStart"], line["yStart"], line["xStart"], line["yStart"]),
            )
            if d <= 10.0:
                return line["id"]
        for furn in st["furniture"]:
            if (
                abs(x - furn["x"]) <= furn["width"] / 2 + 1e-6
                and abs(y - furn["y"]) <= furn["depth"] / 2 + 1e-6
            ):
                return furn["id"]
        for wall in st["walls"]:
            if self._dist_point_segment(x, y, wall["xStart"], wall["yStart"], wall["xEnd"], wall["yEnd"]) <= max(
                wall["thickness"] / 2, 3.0
            ):
                return wall["id"]
        for room in st["rooms"]:
            if self._point_in_polygon(x, y, room["points"]):
                return room["id"]
        return None

    def _selected_objects(self) -> list[tuple[str, dict[str, Any]]]:
        sel = set(self._state["selection"])
        out: list[tuple[str, dict[str, Any]]] = []
        for coll in COLLECTIONS:
            for obj in self._state[coll]:
                if obj["id"] in sel:
                    out.append((coll, obj))
        return out

    def _create_wall(self, ax: float, ay: float, bx: float, by: float) -> str | None:
        if math.hypot(bx - ax, by - ay) < EPS:
            return None
        wall = {
            "id": self._next_id("wall"),
            "xStart": round(ax, 3),
            "yStart": round(ay, 3),
            "xEnd": round(bx, 3),
            "yEnd": round(by, 3),
            "arcExtent": None,
            "thickness": WALL_THICKNESS,
            "height": WALL_HEIGHT,
            "heightAtEnd": None,
            "levelRef": None,
            "leftSideColor": None,
            "rightSideColor": None,
            "patternId": None,
        }
        self._state["walls"].append(wall)
        return wall["id"]

    def _create_room(self, points: list[tuple[float, float]]) -> str | None:
        pts = [(round(x, 3), round(y, 3)) for x, y in points]
        if len(pts) < 3:
            return None
        room = {
            "id": self._next_id("room"),
            "name": None,
            "points": [[px, py] for px, py in pts],
            "areaVisible": True,
            "floorVisible": True,
            "floorColor": None,
            "ceilingVisible": False,
            "levelRef": None,
        }
        self._state["rooms"].append(room)
        return room["id"]

    def _finish_wall_click(self, x: float, y: float, dbl: bool) -> None:
        if not self._chain:
            if not dbl:
                self._chain = [(x, y)]
            return
        start = self._chain[0]
        closes = len(self._chain) >= 3 and math.hypot(x - start[0], y - start[1]) < EPS
        end_run = dbl or closes
        target = start if closes else (x, y)
        prev = self._chain[-1]
        if math.hypot(target[0] - prev[0], target[1] - prev[1]) >= EPS:
            self._mutate()
            self._create_wall(prev[0], prev[1], target[0], target[1])
            self._chain.append(target)
        if end_run:
            if closes:
                self._mutate()
                self._create_room(self._chain[:-1])
            self._chain = []

    # ---- lifecycle ----

    def _cmd_ping(self, p: dict[str, Any]) -> dict[str, Any]:
        return {"pong": True}

    def _cmd_new_home(self, p: dict[str, Any]) -> dict[str, Any]:
        self._state = _empty_state()
        self._undo_stack.clear()
        self._redo_stack.clear()
        self._chain = []
        self._clipboard.clear()
        self._counters.clear()
        return {}

    def _cmd_save(self, p: dict[str, Any]) -> dict[str, Any]:
        path = Path(p["path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"schemaVersion": 1, "state": self._state}, indent=1), encoding="utf-8")
        return {}

    def _cmd_open(self, p: dict[str, Any]) -> dict[str, Any]:
        path = Path(p["path"])
        if not path.is_file():
            raise AdapterError(f"file not found: {p['path']}", "NO_TARGET")
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise AdapterError(f"invalid project file: {exc}", "INVALID_FILE") from exc
        state = doc.get("state")
        if doc.get("schemaVersion") != 1 or not isinstance(state, dict):
            raise AdapterError("unsupported or malformed project file", "INVALID_FILE")
        self._mutate()
        self._state = copy.deepcopy(state)
        self._refresh_capabilities()
        return {}

    # ---- tools & interaction ----

    def _cmd_select_tool(self, p: dict[str, Any]) -> dict[str, Any]:
        self._state["activeTool"] = p["tool"]
        self._chain = []
        return {}

    def _cmd_move_mouse(self, p: dict[str, Any]) -> dict[str, Any]:
        self._last_mouse = (float(p["x"]), float(p["y"]))
        return {}

    def _cmd_click(self, p: dict[str, Any]) -> dict[str, Any]:
        tool = self._state["activeTool"]
        dbl = bool(p.get("dbl"))
        shift = bool(p.get("shift"))
        x, y = self._snap(float(p["x"]), float(p["y"]))
        if tool == "wall":
            self._finish_wall_click(x, y, dbl)
        elif tool == "room":
            if dbl:
                pts = self._chain + ([(x, y)] if self._chain and self._chain[-1] != (x, y) else [])
                if len(pts) >= 3:
                    self._mutate()
                    self._create_room(pts)
                self._chain = []
            elif not self._chain or self._chain[-1] != (x, y):
                self._chain.append((x, y))
        elif tool == "selection":
            hit = self._hit_test(x, y)
            if hit is None:
                if not shift:
                    self._state["selection"] = []
            elif shift:
                sel = list(self._state["selection"])
                self._state["selection"] = [i for i in sel if i != hit] if hit in sel else [*sel, hit]
            else:
                self._state["selection"] = [hit]
        return {}

    def _cmd_drag(self, p: dict[str, Any]) -> dict[str, Any]:
        dx = float(p["toX"]) - float(p["fromX"])
        dy = float(p["toY"]) - float(p["fromY"])
        if self._state["activeTool"] != "selection" or not self._state["selection"]:
            return {}
        objects = self._selected_objects()
        if not objects:
            return {}
        self._mutate()
        for _, obj in objects:
            kind = obj["id"].split("-", 1)[0]
            if kind == "wall":
                obj["xStart"] = round(obj["xStart"] + dx, 3)
                obj["yStart"] = round(obj["yStart"] + dy, 3)
                obj["xEnd"] = round(obj["xEnd"] + dx, 3)
                obj["yEnd"] = round(obj["yEnd"] + dy, 3)
            elif kind == "furniture" or kind == "label":
                obj["x"] = round(obj["x"] + dx, 3)
                obj["y"] = round(obj["y"] + dy, 3)
            elif kind == "room":
                obj["points"] = [[round(px + dx, 3), round(py + dy, 3)] for px, py in obj["points"]]
            elif kind == "dimensionLine":
                obj["xStart"] = round(obj["xStart"] + dx, 3)
                obj["yStart"] = round(obj["yStart"] + dy, 3)
                obj["xEnd"] = round(obj["xEnd"] + dx, 3)
                obj["yEnd"] = round(obj["yEnd"] + dy, 3)
        return {}

    def _cmd_key(self, p: dict[str, Any]) -> dict[str, Any]:
        key = p["key"]
        if key == "escape":
            self._chain = []
            self._state["selection"] = []
        elif key in ("delete", "backspace"):
            self._cmd_delete_selection({})
        return {}

    def _cmd_set_magnetism(self, p: dict[str, Any]) -> dict[str, Any]:
        self._magnetism = bool(p["enabled"])
        return {}

    # ---- editing actions ----

    def _caps(self) -> dict[str, bool]:
        return dict(self._state["capabilities"])

    def _cmd_undo(self, p: dict[str, Any]) -> dict[str, Any]:
        if not self._undo_stack:
            return self._caps()
        self._redo_stack.append(copy.deepcopy(self._state))
        self._state = self._undo_stack.pop()
        self._refresh_capabilities()
        return self._caps()

    def _cmd_redo(self, p: dict[str, Any]) -> dict[str, Any]:
        if not self._redo_stack:
            return self._caps()
        self._undo_stack.append(copy.deepcopy(self._state))
        self._state = self._redo_stack.pop()
        self._refresh_capabilities()
        return self._caps()

    def _cmd_delete_selection(self, p: dict[str, Any]) -> dict[str, Any]:
        sel = set(self._state["selection"])
        if not sel:
            return {}
        self._mutate()
        for coll in COLLECTIONS:
            self._state[coll] = [obj for obj in self._state[coll] if obj["id"] not in sel]
        self._state["selection"] = []
        return {}

    def _cmd_copy(self, p: dict[str, Any]) -> dict[str, Any]:
        self._clipboard = [(coll, copy.deepcopy(obj)) for coll, obj in self._selected_objects()]
        return {}

    def _cmd_paste(self, p: dict[str, Any]) -> dict[str, Any]:
        if not self._clipboard:
            return {}
        self._mutate()
        new_ids: list[str] = []
        for coll, obj in self._clipboard:
            clone = copy.deepcopy(obj)
            clone["id"] = self._next_id(obj["id"].split("-", 1)[0])
            if coll == "walls":
                clone["xStart"] += PASTE_OFFSET
                clone["yStart"] += PASTE_OFFSET
                clone["xEnd"] += PASTE_OFFSET
                clone["yEnd"] += PASTE_OFFSET
            elif coll == "rooms":
                clone["points"] = [[px + PASTE_OFFSET, py + PASTE_OFFSET] for px, py in clone["points"]]
            elif coll in ("furniture", "labels"):
                clone["x"] += PASTE_OFFSET
                clone["y"] += PASTE_OFFSET
            else:
                clone["xStart"] += PASTE_OFFSET
                clone["yStart"] += PASTE_OFFSET
                clone["xEnd"] += PASTE_OFFSET
                clone["yEnd"] += PASTE_OFFSET
            self._state[coll].append(clone)
            new_ids.append(clone["id"])
        self._state["selection"] = new_ids
        return {}

    def _cmd_duplicate(self, p: dict[str, Any]) -> dict[str, Any]:
        self._cmd_copy({})
        return self._cmd_paste({})

    def _cmd_select_all(self, p: dict[str, Any]) -> dict[str, Any]:
        ids: list[str] = []
        for coll in COLLECTIONS:
            ids.extend(obj["id"] for obj in self._state[coll])
        self._state["selection"] = ids
        return {}

    def _cmd_clear_selection(self, p: dict[str, Any]) -> dict[str, Any]:
        self._state["selection"] = []
        return {}

    def _cmd_select_object(self, p: dict[str, Any]) -> dict[str, Any]:
        target = p["objectId"]
        for coll in COLLECTIONS:
            if any(obj["id"] == target for obj in self._state[coll]):
                self._state["selection"] = [target]
                return {}
        raise AdapterError(f"objectId '{target}' not found", "NO_TARGET")

    MODIFY_KEYS = ("angleDeg", "x", "y", "width", "depth", "height", "elevation", "thickness")

    def _cmd_modify_selected(self, p: dict[str, Any]) -> dict[str, Any]:
        props = p.get("props") or {}
        applied = {k: v for k, v in props.items() if k in self.MODIFY_KEYS}
        if not applied:
            return {}
        objects = self._selected_objects()
        if not objects:
            raise AdapterError("nothing selected to modify", "NO_TARGET")
        self._mutate()
        for _, obj in objects:
            for k, v in applied.items():
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    obj[k] = round(float(v), 3)
        return {}

    # ---- furniture ----

    def _cmd_add_furniture(self, p: dict[str, Any]) -> dict[str, Any]:
        entry = next((c for c in CATALOG if c["catalogId"] == p["catalogId"]), None)
        if entry is None:
            known = ", ".join(sorted(c["catalogId"] for c in CATALOG))
            raise AdapterError(f"unknown catalogId '{p['catalogId']}' (known: {known})", "UNKNOWN_CATALOG_ID")
        self._mutate()
        furn = {
            "id": self._next_id("furn"),
            "catalogId": entry["catalogId"],
            "name": entry["name"],
            "x": round(float(p["x"]), 3),
            "y": round(float(p["y"]), 3),
            "elevation": 0.0,
            "angleDeg": round(float(p.get("angleDeg", 0.0)), 3),
            "pitchDeg": 0.0,
            "rollDeg": 0.0,
            "width": entry["width"],
            "depth": entry["depth"],
            "height": entry["height"],
            "color": None,
            "visible": True,
            "movable": True,
            "doorOrWindow": entry["doorOrWindow"],
            "levelRef": None,
        }
        self._state["furniture"].append(furn)
        return {"objectId": furn["id"]}

    def _cmd_list_catalog(self, p: dict[str, Any]) -> dict[str, Any]:
        return {
            "items": [
                {
                    "catalogId": c["catalogId"],
                    "name": c["name"],
                    "width": c["width"],
                    "depth": c["depth"],
                    "height": c["height"],
                    "doorOrWindow": c["doorOrWindow"],
                }
                for c in CATALOG
            ]
        }

    # ---- view / camera ----

    def _cmd_zoom(self, p: dict[str, Any]) -> dict[str, Any]:
        factor = float(p["factor"])
        if factor <= 0:
            raise AdapterError("zoom factor must be positive", "INVALID_PARAMS")
        self._scale *= factor
        return {"scale": round(self._scale, 3)}

    def _cmd_set_view(self, p: dict[str, Any]) -> dict[str, Any]:
        self._view = p["view"]
        return {}

    def _cmd_set_camera(self, p: dict[str, Any]) -> dict[str, Any]:
        cam = self._state["cameras"]["observer"]
        for key in ("x", "y", "z", "yawDeg", "pitchDeg", "fovDeg"):
            cam[key] = round(float(p[key]), 3)
        return {}

    def _cmd_camera_preset(self, p: dict[str, Any]) -> dict[str, Any]:
        preset = p["preset"]
        defaults = CAMERA_TOP if preset == "top" else CAMERA_OBSERVER
        self._state["cameras"][preset] = dict(defaults)
        return {"camera": dict(defaults)}

    # ---- introspection & capture ----

    def _cmd_get_state(self, p: dict[str, Any]) -> dict[str, Any]:
        return _round3(copy.deepcopy(self._state))

    def _render_plan(self, width: int, height: int) -> Image.Image:
        img = Image.new("RGB", (width, height), (255, 255, 255))
        draw = ImageDraw.Draw(img)
        st = self._state
        xs: list[float] = [-100.0, 100.0]
        ys: list[float] = [-100.0, 100.0]
        for wall in st["walls"]:
            xs.extend((wall["xStart"], wall["xEnd"]))
            ys.extend((wall["yStart"], wall["yEnd"]))
        margin = 20.0
        span_x = max(max(xs) - min(xs), 1.0)
        span_y = max(max(ys) - min(ys), 1.0)
        scale = min((width - 2 * margin) / span_x, (height - 2 * margin) / span_y)

        def tx(x): return (x - (max(xs) + min(xs)) / 2) * scale + width / 2

        def ty(y): return (y - (max(ys) + min(ys)) / 2) * scale + height / 2

        for room in st["rooms"]:
            poly = [(tx(px), ty(py)) for px, py in room["points"]]
            draw.polygon(poly, fill=(238, 238, 224))
        lw = max(1, round(WALL_THICKNESS * scale))
        for wall in st["walls"]:
            draw.line(
                [(tx(wall["xStart"]), ty(wall["yStart"])), (tx(wall["xEnd"]), ty(wall["yEnd"]))],
                fill=(40, 40, 40),
                width=lw,
            )
        for furn in st["furniture"]:
            cx, cy = tx(furn["x"]), ty(furn["y"])
            hw = max(1.0, furn["width"] / 2 * scale)
            hd = max(1.0, furn["depth"] / 2 * scale)
            color = (150, 150, 190) if not furn["doorOrWindow"] else (120, 170, 120)
            draw.rectangle([cx - hw, cy - hd, cx + hw, cy + hd], fill=color)
        if st["selection"]:
            draw.rectangle([2, 2, width - 3, height - 3], outline=(220, 60, 60), width=2)
        return img

    def _render_3d(self, width: int, height: int) -> Image.Image:
        img = Image.new("RGB", (width, height), (200, 224, 248))
        draw = ImageDraw.Draw(img)
        draw.rectangle([0, height // 2, width, height], fill=(180, 168, 140))
        horizon = height // 2
        st = self._state
        for wall in sorted(st["walls"], key=lambda w: -(w["xStart"] + w["xEnd"])):
            depth = (wall["yStart"] + wall["yEnd"]) / 2
            h = max(2.0, WALL_HEIGHT * 0.5 * (400.0 / max(abs(depth - 300.0), 100.0)))
            top = horizon - h
            bottom = horizon + h
            shade = int(max(60, min(230, 230 - abs(depth) / 4)))
            draw.rectangle([10, top, width // 3, bottom], fill=(shade, shade - 12, shade - 30))
        return img

    def _cmd_screenshot(self, p: dict[str, Any]) -> dict[str, Any]:
        view = p["view"]
        width, height = int(p["width"]), int(p["height"])
        img = self._render_plan(width, height) if view == "plan" else self._render_3d(width, height)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return {
            "pngBase64": base64.b64encode(buf.getvalue()).decode("ascii"),
            "width": width,
            "height": height,
        }

    def _cmd_get_capabilities(self, p: dict[str, Any]) -> dict[str, Any]:
        return {"commands": sorted(COMMANDS)}
