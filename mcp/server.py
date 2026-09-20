"""BuildMyHouse MCP server — let ChatGPT / Claude drive the house designer.

The app connects out to this local server over the automation WebSocket;
MCP tools forward protocol commands to that connected session.

Launch flow (the "easy path"):
  1. Start this server (e.g. via run.sh). It prints the WS port on stderr.
  2. Launch Homely pointed at it:
       HOMELY_AUTOMATION_PORT=<port> npm run tauri dev
  3. Tell your assistant: "Use the homely MCP tools to design a house."

Works with Claude Desktop and ChatGPT desktop (stdio MCP). For cloud ChatGPT
set HOMELY_MCP_HTTP_PORT to expose a streamable-HTTP endpoint.
"""
from __future__ import annotations

import contextlib
import json
import os
import queue
import sys
import threading

import anyio
from automation_server import AutomationServer, Session
from axiom_client import AxiomClient
from scene_analysis import analyze_home, validate_home
from mcp.server.fastmcp import Context, FastMCP, Image
from mcp.shared.message import SessionMessage
from mcp.types import JSONRPCMessage

try:
    from pydantic import AnyHttpUrl
    from mcp.server.auth.provider import AccessToken, TokenVerifier
    from mcp.server.auth.middleware.auth_context import get_access_token
    from mcp.server.auth.settings import AuthSettings
except ImportError:  # stdio-only installs can run without the HTTP auth extras.
    AnyHttpUrl = AccessToken = TokenVerifier = AuthSettings = get_access_token = None

# SECURITY (M17 audit): loopback-only by default, on purpose. The automation
# protocol has no auth, so anything that can reach this port can register a
# session and receive/answer its requests — keep it on 127.0.0.1 unless you
# explicitly need LAN/cloud access (HOMELY_MCP_HOST), and then only on a
# trusted network. See homely/src/automation/README.md "Security".
HOST = os.environ.get("HOMELY_MCP_HOST", "127.0.0.1")
PORT = int(os.environ.get("HOMELY_MCP_PORT", "9529"))
HTTP_PORT = int(os.environ["HOMELY_MCP_HTTP_PORT"]) if os.environ.get("HOMELY_MCP_HTTP_PORT") else None
MCP_RESOURCE_URL = os.environ.get(
    "BUILDMYHOUSE_MCP_RESOURCE_URL",
    f"http://127.0.0.1:{HTTP_PORT}/mcp" if HTTP_PORT else "http://127.0.0.1:9529/mcp",
)
MCP_ISSUER_URL = os.environ.get("BUILDMYHOUSE_MCP_ISSUER_URL", MCP_RESOURCE_URL)


def _token_users() -> dict[str, str]:
    raw = os.environ.get("BUILDMYHOUSE_MCP_TOKENS_JSON", "")
    users: dict[str, str] = {}
    if raw:
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("BUILDMYHOUSE_MCP_TOKENS_JSON must be a JSON object of token:user")
        users.update({str(token): str(user) for token, user in parsed.items()})
    token = os.environ.get("BUILDMYHOUSE_MCP_TOKEN")
    if token:
        users[token] = os.environ.get("BUILDMYHOUSE_MCP_USER", "test")
    return users


class StaticTokenVerifier(TokenVerifier if TokenVerifier is not None else object):
    def __init__(self, users: dict[str, str], resource: str):
        self.users = users
        self.resource = resource

    async def verify_token(self, token: str):
        user = self.users.get(token)
        if user is None or AccessToken is None:
            return None
        return AccessToken(token=token, client_id=user, scopes=["design"], resource=self.resource)

INSTRUCTIONS = """\
BuildMyHouse is a house-design app. Coordinates are centimeters in plan space (x right, y down).
Angles are degrees. The connected app holds the live home; each tool mutates it. After drawing,
call get_home_state or screenshot to verify.
Use homely_status first. For fast construction use build_house; then call scene_summary or
validate_scene for semantic verification and screenshot for visual verification. Coordinates
are centimeters, x-right/y-down. Furniture is normally placed by catalog id."""

@contextlib.asynccontextmanager
async def _lifespan(_app):
    await _ensure_server()
    try:
        yield {}
    finally:
        await _stop_server()


_TOKENS = _token_users()
_AUTH_KWARGS = {}
if HTTP_PORT and not _TOKENS:
    raise RuntimeError("HTTP MCP requires BUILDMYHOUSE_MCP_TOKEN or BUILDMYHOUSE_MCP_TOKENS_JSON")
if HTTP_PORT and _TOKENS:
    if not all((AnyHttpUrl, AuthSettings, TokenVerifier)):
        raise RuntimeError("HTTP token auth requires a current mcp[cli] package")
    _AUTH_KWARGS = {
        "token_verifier": StaticTokenVerifier(_TOKENS, MCP_RESOURCE_URL),
        "auth": AuthSettings(
            issuer_url=AnyHttpUrl(MCP_ISSUER_URL),
            resource_server_url=AnyHttpUrl(MCP_RESOURCE_URL),
            required_scopes=["design"],
            validate_token_resource=False,
        ),
    }

mcp = FastMCP("buildmyhouse", instructions=INSTRUCTIONS, lifespan=_lifespan if HTTP_PORT else None, **_AUTH_KWARGS)

_SERVER: AutomationServer | None = None


async def _ensure_server() -> None:
    global _SERVER
    if _SERVER is not None:
        return
    _SERVER = AutomationServer(host=HOST, ws_port=PORT)
    await _SERVER.start()
    sys.stderr.write(
        f"[buildmyhouse-mcp] listening on ws://{HOST}:{_SERVER.ws_port}\n"
        f"[buildmyhouse-mcp] launch the app with HOMELY_AUTOMATION_PORT={_SERVER.ws_port}\n"
    )
    sys.stderr.flush()


async def _stop_server() -> None:
    global _SERVER
    if _SERVER is not None:
        await _SERVER.stop()
        _SERVER = None


@contextlib.asynccontextmanager
async def _stdio_transport():
    """Pipe transport compatible with Python clients that keep stdin open."""
    read_writer, read_stream = anyio.create_memory_object_stream(0)
    write_stream, write_reader = anyio.create_memory_object_stream(0)
    incoming: queue.Queue[str | None] = queue.Queue()

    def stdin_thread():
        while True:
            line = sys.stdin.buffer.readline()
            incoming.put(line.decode("utf-8", errors="replace") if line else None)
            if not line:
                return

    threading.Thread(target=stdin_thread, daemon=True).start()

    async def read_stdin():
        async with read_writer:
            while True:
                try:
                    line = incoming.get_nowait()
                except queue.Empty:
                    await anyio.sleep(0.01)
                    continue
                if line is None:
                    return
                try:
                    await read_writer.send(SessionMessage(JSONRPCMessage.model_validate_json(line)))
                except Exception as exc:
                    await read_writer.send(exc)

    def write_stdout(payload: str) -> None:
        sys.stdout.write(payload)
        sys.stdout.flush()

    async def write_stdout_loop():
        async with write_reader:
            async for message in write_reader:
                payload = message.message.model_dump_json(by_alias=True, exclude_none=True) + "\n"
                await anyio.to_thread.run_sync(write_stdout, payload)

    async with anyio.create_task_group() as tasks:
        tasks.start_soon(read_stdin)
        tasks.start_soon(write_stdout_loop)
        yield read_stream, write_stream


async def _run_stdio() -> None:
    async with _stdio_transport() as (read_stream, write_stream):
        await mcp._mcp_server.run(
            read_stream,
            write_stream,
            mcp._mcp_server.create_initialization_options(),
        )


def _session() -> Session:
    if _SERVER is None:
        raise RuntimeError("server not started")
    for preferred in ("homely", "buildmyhouse"):
        if preferred in _SERVER.sessions:
            return _SERVER.sessions[preferred]
    port = _SERVER.ws_port
    raise RuntimeError(
        f"No app connected to ws://{HOST}:{port}. Launch the app with "
        f"HOMELY_AUTOMATION_PORT={port}."
    )


@mcp.tool()
async def homely_status() -> dict:
    """Report the WS port and which app is connected."""
    await _ensure_server()
    if _SERVER is None:
        return {"connected": [], "port": None}
    return {"connected": list(_SERVER.sessions.keys()), "port": _SERVER.ws_port}


@mcp.tool()
async def mcp_identity(ctx: Context) -> dict:
    """Return the configured MCP identity without revealing its token."""
    access = get_access_token() if get_access_token is not None else None
    return {"user": access.client_id if access else os.environ.get("BUILDMYHOUSE_MCP_USER", "test"),
            "transport": "http" if HTTP_PORT else "stdio", "authenticated": access is not None or not HTTP_PORT}


@mcp.tool()
async def reset_home() -> dict:
    """Start a fresh empty home (clears undo history)."""
    return await _session().request("new_home")


@mcp.tool()
async def build_house(plan: dict, reset: bool = True) -> dict:
    """Build a complete house from one declarative plan and return its state.

    Plan shape: {name?, levels?, walls?, rooms?, furniture?, doors?, windows?,
    roofs?, polylines?, labels?, dimensions?, camera?}. Coordinates are centimeters. Each
    wall may have a local `key`; openings refer to that key. Each level may have
    a local `key`; objects may use `levelKey`. If `walls` is omitted, closed
    room polygons generate walls automatically (explicit walls are better for
    shared walls). Use screenshot(view='plan'|'3d') after this tool.
    """
    if not isinstance(plan, dict):
        raise ValueError("plan must be an object")
    s = _session()
    if reset:
        await s.request("new_home")
    level_ids: dict[str, str] = {}
    wall_ids: dict[str, str] = {}

    for level in plan.get("levels", []):
        result = await s.request("add_level", {
            "name": level.get("name", "Level"),
            "elevation": level["elevation"],
            "floorThickness": level.get("floorThickness", 20),
            "height": level.get("height", 250),
        })
        if level.get("key"):
            level_ids[level["key"]] = result["id"]

    walls = list(plan.get("walls", []))
    if not walls and plan.get("auto_walls", True):
        for room in plan.get("rooms", []):
            points = room["points"]
            walls.extend({"xStart": a[0], "yStart": a[1], "xEnd": b[0], "yEnd": b[1],
                          "levelKey": room.get("levelKey")}
                         for a, b in zip(points, points[1:] + points[:1]))
    for wall in walls:
        params = {k: wall[k] for k in (
            "xStart", "yStart", "xEnd", "yEnd", "thickness", "height",
            "arcExtent", "heightAtEnd", "patternId", "leftSideColor",
            "rightSideColor", "leftSideTextureId", "rightSideTextureId"
        ) if k in wall}
        if wall.get("levelKey") in level_ids:
            params["levelRef"] = level_ids[wall["levelKey"]]
        result = await s.request("add_wall", params)
        if wall.get("key"):
            wall_ids[wall["key"]] = result["id"]

    for room in plan.get("rooms", []):
        params = {"points": room["points"]}
        for source, target in (("name", "name"), ("floorColor", "floorColor"),
                               ("floorVisible", "floorVisible"), ("ceilingVisible", "ceilingVisible"),
                               ("areaVisible", "areaVisible")):
            if source in room:
                params[target] = room[source]
        if room.get("levelKey") in level_ids:
            params["levelRef"] = level_ids[room["levelKey"]]
        await s.request("add_room", params)

    for opening, command in (("doors", "add_door"), ("windows", "add_window")):
        for item in plan.get(opening, []):
            wall_id = wall_ids.get(item.get("wallKey"), item.get("wallId"))
            if not wall_id:
                raise ValueError(f"{opening} item requires wallKey or wallId")
            params = {"wallId": wall_id}
            if "x" in item:
                params["x"] = item["x"]
            if "width" in item:
                params["width"] = item["width"]
            await s.request(command, params)

    for item in plan.get("furniture", []):
        params = {"x": item["x"], "y": item["y"], "angleDeg": item.get("angleDeg", 0)}
        if item.get("levelKey") in level_ids:
            params["levelRef"] = level_ids[item["levelKey"]]
            params["elevation"] = item.get("elevation", 0)
        elif "elevation" in item:
            params["elevation"] = item["elevation"]
        if item.get("catalogId"):
            params["catalogId"] = item["catalogId"]
            await s.request("catalog_add_furniture", params)
        else:
            params.update({k: item[k] for k in ("name", "width", "depth", "height") if k in item})
            await s.request("add_furniture", params)

    for item in plan.get("roofs", []):
        params = {k: item[k] for k in (
            "points", "name", "color", "style", "pitchDeg", "overhangCm", "ridgeAngleDeg"
        ) if k in item}
        if item.get("levelKey") in level_ids:
            params["levelRef"] = level_ids[item["levelKey"]]
        await s.request("add_roof", params)
    for item in plan.get("polylines", []):
        await s.request("add_polyline", {k: item[k] for k in (
            "points", "closed", "name", "color", "thickness"
        ) if k in item})
    for item in plan.get("labels", []):
        await s.request("add_label", {k: item[k] for k in ("x", "y", "text") if k in item})
    for item in plan.get("dimensions", []):
        await s.request("add_dimension_line", {k: item[k] for k in (
            "xStart", "yStart", "xEnd", "yEnd", "offset"
        ) if k in item})
    if isinstance(plan.get("camera"), dict):
        await s.request("set_camera", plan["camera"])
    state = await s.request("get_state")
    return {"state": state, "levelIds": level_ids, "wallIds": wall_ids}


@mcp.tool()
async def get_home_state() -> dict:
    """Return the full NormalizedHomeState JSON (walls, rooms, furniture, cameras)."""
    return await _session().request("get_state")


@mcp.tool()
async def scene_summary() -> dict:
    """Return a compact semantic scene graph for reasoning without pixels."""
    return analyze_home(await _session().request("get_state"))


@mcp.tool()
async def validate_scene() -> dict:
    """Check the scene for structural problems and return warnings plus summary."""
    return validate_home(await _session().request("get_state"))


@mcp.tool()
async def screenshot(view: str, width: int = 800, height: int = 600) -> Image:
    """Render an OFFSCREEN image of the home. view='plan' or '3d'."""
    data = await _session().request("screenshot", {"view": view, "width": width, "height": height})
    return Image(data=data["pngBase64"], format="png")


@mcp.tool()
async def list_furniture() -> dict:
    """List the furniture catalog (catalogId, name, width/depth/height cm, doorOrWindow)."""
    return await _session().request("list_catalog")


@mcp.tool()
async def add_furniture(
    catalog_id: str,
    x: float,
    y: float,
    angle_deg: float = 0,
    elevation: float | None = None,
) -> dict:
    """Place a catalog item at plan coords (cm). Returns {id}."""
    params: dict = {"catalogId": catalog_id, "x": x, "y": y, "angleDeg": angle_deg}
    if elevation is not None:
        params["elevation"] = elevation
    return await _session().request("catalog_add_furniture", params)


@mcp.tool()
async def draw_rectangular_room(x: float, y: float, width: float, height: float) -> dict:
    """Draw a closed 4-wall rectangle AND a matching room floor (one each).
    Walls enclose the footprint; the room gives a real floor/ceiling. Magnetism off for exact corners."""
    s = _session()
    await s.request("select_tool", {"tool": "wall"})
    await s.request("set_magnetism", {"enabled": False})
    corners = [(x, y), (x + width, y), (x + width, y + height), (x, y + height)]
    for cx, cy in corners:
        await s.request("click", {"x": cx, "y": cy})
    await s.request("click", {"x": x, "y": y, "dbl": True})
    await s.request("add_room", {"points": corners})
    return await s.request("get_state")


@mcp.tool()
async def add_wall(
    x_start: float, y_start: float, x_end: float, y_end: float,
    thickness: float = 7, height: float = 250, level_ref: str | None = None,
) -> dict:
    """Add one wall directly in plan coordinates (cm)."""
    params = {"xStart": x_start, "yStart": y_start, "xEnd": x_end, "yEnd": y_end,
              "thickness": thickness, "height": height}
    if level_ref is not None:
        params["levelRef"] = level_ref
    return await _session().request("add_wall", params)


@mcp.tool()
async def add_roof(
    points: list[list[float]], style: str = "gable", pitch_deg: float = 30,
    overhang_cm: float = 30, level_ref: str | None = None,
) -> dict:
    """Add a gable or hip roof footprint from plan points."""
    params: dict = {"points": points, "style": style, "pitchDeg": pitch_deg, "overhangCm": overhang_cm}
    if level_ref is not None:
        params["levelRef"] = level_ref
    return await _session().request("add_roof", params)


@mcp.tool()
async def add_room(
    points: list[list[float]],
    name: str | None = None,
    floor_color: int | None = None,
    floor_visible: bool = True,
    ceiling_visible: bool = False,
) -> dict:
    """Create a room (floor/ceiling) from a polygon of plan points [[x,y], ...] (>=3). Returns {id}."""
    params: dict = {"points": points}
    if name is not None:
        params["name"] = name
    if floor_color is not None:
        params["floorColor"] = floor_color
    params["floorVisible"] = floor_visible
    params["ceilingVisible"] = ceiling_visible
    return await _session().request("add_room", params)


@mcp.tool()
async def add_level(name: str, elevation: float, floor_thickness: float, height: float | None = None) -> dict:
    """Add a building level (storey) at the given elevation (cm). Returns {id}."""
    params: dict = {"name": name, "elevation": elevation, "floorThickness": floor_thickness}
    if height is not None:
        params["height"] = height
    return await _session().request("add_level", params)


@mcp.tool()
async def remove_level(level_id: str) -> dict:
    """Remove a level by id."""
    return await _session().request("remove_level", {"id": level_id})


@mcp.tool()
async def add_dimension_line(
    x_start: float, y_start: float, x_end: float, y_end: float, offset: float = 0
) -> dict:
    """Add a dimension line between two plan points (cm). Returns {id}."""
    return await _session().request(
        "add_dimension_line",
        {"xStart": x_start, "yStart": y_start, "xEnd": x_end, "yEnd": y_end, "offset": offset},
    )


@mcp.tool()
async def add_label(x: float, y: float, text: str = "Label") -> dict:
    """Add a text label at plan coords (cm). Returns {id}."""
    return await _session().request("add_label", {"x": x, "y": y, "text": text})


@mcp.tool()
async def select_object(object_id: str) -> dict:
    """Select a single object by its state id."""
    return await _session().request("select_object", {"objectId": object_id})


@mcp.tool()
async def select_all() -> dict:
    """Select every object in the home."""
    return await _session().request("select_all")


@mcp.tool()
async def clear_selection() -> dict:
    """Clear the current selection."""
    return await _session().request("clear_selection")


@mcp.tool()
async def delete_selection() -> dict:
    """Delete everything currently selected."""
    return await _session().request("delete_selection")


@mcp.tool()
async def modify_selected(props: dict) -> dict:
    """Modify the selected object(s). props is a dict of fields to change
    (e.g. {x, y, width, height, angleDeg, elevation, floorColor, thickness})."""
    return await _session().request("modify_selected", {"props": props})


@mcp.tool()
async def zoom(factor: float) -> dict:
    """Zoom the active 3D camera by a factor (>1 zoom out, <1 zoom in). Returns {scale}."""
    return await _session().request("zoom", {"factor": factor})


@mcp.tool()
async def set_view(view: str) -> dict:
    """Switch the view: 'plan' or '3d'."""
    return await _session().request("set_view", {"view": view})


@mcp.tool()
async def save_project(path: str | None = None) -> dict:
    """Save the home. Returns {json} (serialized home); if path given, also stored session-locally.
    Keep the returned json to restore later via open_project(json=...)."""
    if path is None:
        return await _session().request("save", {})
    return await _session().request("save", {"path": path})


@mcp.tool()
async def open_project(path: str | None = None, json: dict | None = None) -> dict:
    """Load a home. Pass json (a serialized home from save_project) to restore a design,
    or path to reload a session-local save."""
    if json is not None:
        return await _session().request("open", {"json": json})
    if path is not None:
        return await _session().request("open", {"path": path})
    raise ValueError("open_project requires json or path")


@mcp.tool()
async def select_tool(tool: str) -> dict:
    """Set the active tool: selection|panning|wall|room|polyline|dimensionLine|label."""
    return await _session().request("select_tool", {"tool": tool})


@mcp.tool()
async def click(x: float, y: float, dbl: bool = False, shift: bool = False) -> dict:
    """Click in plan space (cm). dbl=true closes the current wall chain."""
    return await _session().request("click", {"x": x, "y": y, "dbl": dbl, "shift": shift})


@mcp.tool()
async def drag(from_x: float, from_y: float, to_x: float, to_y: float, shift: bool = False) -> dict:
    """Drag from one plan point to another (move/resize gesture)."""
    return await _session().request(
        "drag", {"fromX": from_x, "fromY": from_y, "toX": to_x, "toY": to_y, "shift": shift}
    )


@mcp.tool()
async def key(key: str) -> dict:
    """Send a plan key: escape|delete|backspace."""
    return await _session().request("key", {"key": key})


@mcp.tool()
async def set_magnetism(enabled: bool) -> dict:
    """Enable/disable grid/angle magnetism for subsequent drawing."""
    return await _session().request("set_magnetism", {"enabled": enabled})


@mcp.tool()
async def set_camera(
    x: float | None = None,
    y: float | None = None,
    z: float | None = None,
    yaw_deg: float | None = None,
    pitch_deg: float | None = None,
    fov_deg: float | None = None,
) -> dict:
    """Move the active 3D camera. Any omitted field is left unchanged."""
    params = {k: v for k, v in {
        "x": x, "y": y, "z": z, "yawDeg": yaw_deg, "pitchDeg": pitch_deg, "fovDeg": fov_deg
    }.items() if v is not None}
    return await _session().request("set_camera", params)


@mcp.tool()
async def camera_preset(preset: str) -> dict:
    """Snap the camera to a preset: 'top' or 'observer'. Returns the resulting camera."""
    return await _session().request("camera_preset", {"preset": preset})


@mcp.tool()
async def undo() -> dict:
    """Undo the last edit. Returns {canUndo, canRedo}."""
    return await _session().request("undo")


@mcp.tool()
async def redo() -> dict:
    """Redo the last undone edit. Returns {canUndo, canRedo}."""
    return await _session().request("redo")


@mcp.tool()
async def telemetry_query(aql: str, timeframe: str = "24h") -> dict:
    """Query Homely telemetry from Axiom."""
    client = AxiomClient()
    if not client.token:
        return {"error": "AXIOM_TOKEN not set"}
    return client.query(aql, timeframe=timeframe)


@mcp.tool()
async def telemetry_summary(metric: str = "errors", timeframe: str = "7d") -> dict:
    """Get a pre-built Axiom summary: errors, performance, or usage."""
    client = AxiomClient()
    if not client.token:
        return {"error": "AXIOM_TOKEN not set"}
    return client.summary(metric, timeframe=timeframe)


def main() -> None:
    if HTTP_PORT:
        mcp.settings.host = HOST
        mcp.settings.port = HTTP_PORT
        mcp.run(transport="streamable-http")
    else:
        anyio.run(_run_stdio)


if __name__ == "__main__":
    main()
