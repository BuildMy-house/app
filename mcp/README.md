# buildmy.house MCP — let ChatGPT / Claude design a house

An MCP server shipped with the BuildMyHouse app. It speaks the app's existing
automation WebSocket protocol and forwards assistant tools to the live app.

## Easy path

1. **Start the MCP server** (stdio, what Claude/ChatGPT desktop expect):

   ```bash
   ./mcp/run.sh
   ```

   It prints the WS port on stderr, e.g. `ws://127.0.0.1:9529`.

2. **Launch the app** (separate terminal; it connects to port 9529 by default):

   ```bash
   npm run tauri dev
   ```

3. **Connect your assistant** — add the MCP config to Claude Desktop or a
   ChatGPT connector. Replace the sample absolute path with this checkout's
   `mcp/run.sh` path. Then say: *"Use build_house to create a 3-bedroom
   house from this image, verify the plan, and render a 3D view."*

For cloud ChatGPT (no local stdio), expose HTTP instead:

```bash
HOMELY_MCP_HTTP_PORT=8080 ./mcp/run.sh
```

and point the connector at `http://127.0.0.1:8080/mcp`.

## Tools

| Tool | Purpose |
|------|---------|
| `homely_status` | Which app is connected + the WS port |
| `mcp_identity` | Current test/user identity (never returns the token) |
| `build_house` | Build a complete declarative house in one call |
| `build_room` | Build one rectangular room, walls, and optional furniture in one call |
| `reset_home` | New empty home |
| `get_home_state` | Full `NormalizedHomeState` JSON |
| `scene_summary` / `validate_scene` | Semantic scene graph and structural checks |
| `screenshot` | Standalone offscreen plan/3D PNG (no browser or human viewport) |
| `render_photoreal` | Optional LuxCore image; defaults to the cheap thumbnail profile |
| `screenshot_views` | Capture several named camera views in one call; empty input returns plan + perspective + top-down |
| `list_furniture` | Catalog items |
| `add_furniture` | Place a catalog item by id (cm coords) |
| `draw_rectangular_room` | Closed 4-wall rectangle (one undo) |
| `select_tool` / `click` / `drag` / `key` / `set_magnetism` | Plan interaction |
| `set_camera` / `camera_preset` | 3D view |
| `look_at` / `frame_scene` / `frame_room` | Aim or automatically frame the active camera |
| `undo` / `redo` | History |

Units: centimeters for lengths, degrees for angles, plan coords x-right / y-down.

## Agent workflow

Use the image as design input, infer approximate dimensions in centimeters,
then call `build_house` with `levels`, `walls`, `rooms`, `doors`, `windows`,
`furniture`, and optional `roofs`. Give walls local `key` values so openings
can refer to them with `wallKey`. If rooms are supplied without walls, the
tool creates walls around each room automatically; use explicit walls when
rooms share boundaries. Call `get_home_state` to check counts and IDs, then
call `screenshot` for both `plan` and `3d` and iterate with the small edit
tools.

For a focused pass, call `frame_room` with a room state id, then use
`look_at` or `screenshot_views` for the exact views you need. The shortest
single-room path is `build_room`; use `reset=false` to add another room to an
existing home.

Minimal shape:

```json
{
  "levels": [{"key": "ground", "name": "Ground floor", "elevation": 0}],
  "walls": [{"key": "north", "xStart": 0, "yStart": 0, "xEnd": 1200, "yEnd": 0}],
  "rooms": [{"name": "Living room", "points": [[0,0],[600,0],[600,500],[0,500]]}],
  "doors": [{"wallKey": "north", "x": 300, "width": 90}],
  "furniture": [{"catalogId": "sofa-3-seater", "x": 250, "y": 250}]
}
```

Give rooms, furniture, roofs, polylines, labels, and dimensions a `key` when
you need to edit or inspect them later. `build_house` returns an ID map for
each keyed collection (`levelIds`, `wallIds`, `roomIds`, `furnitureIds`,
`roofIds`, `polylineIds`, `labelIds`, and `dimensionIds`). Room-only plans
also get predictable generated wall keys such as `living-wall-1`, so doors
and windows can target them without switching to explicit walls. Every
`levelKey` is checked and rejected if it does not resolve to a declared level.

The assistant remains the vision/planning layer; the MCP is the deterministic
scene builder and renderer. A cloud deployment must put the streamable HTTP
endpoint behind authentication and a trusted network boundary. The default
listener is loopback-only because the automation socket has no authentication.

`screenshot` is the cheap iteration path. Configure
`BUILDMYHOUSE_LUXCORE_URL`, `BUILDMYHOUSE_LUXCORE_TOKEN`, and optionally
`BUILDMYHOUSE_LUXCORE_USER` to enable `render_photoreal`; start with
`thumbnail`, then request `low` or `medium` only for a selected final view.

Production house tools use the authenticated API identity. Configure
`BUILDMYHOUSE_API_URL` and a user-scoped `BUILDMYHOUSE_API_TOKEN`; use
`list_plans`, `create_plan`, and `select_plan` before editing a house.

## Identity and HTTP deployment

Stdio clients (Codex and Claude Desktop) launch `mcp/run.sh`; it loads the
workspace `.env` and uses the local `test` identity. For streamable HTTP, set
`BUILDMYHOUSE_MCP_TOKENS_JSON` to a JSON object mapping bearer tokens to user
names, for example `{"token-for-alice":"alice"}`. The server rejects HTTP
startup without a token and validates `Authorization: Bearer ...` on every MCP
request. Set `BUILDMYHOUSE_MCP_RESOURCE_URL` to the public `/mcp` URL in prod.

The MCP does not infer architectural dimensions or identify furniture from
pixels; those are assistant-side decisions and should be checked against the
returned plan screenshot.
