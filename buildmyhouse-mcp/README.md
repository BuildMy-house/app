# Homely MCP — let ChatGPT / Claude design a house

An MCP server that exposes the Homely house designer (and, optionally, the
original Sweet Home 3D driver) as tools an AI assistant can call. It reuses the
frozen automation protocol (`docs/specs/ws-protocol.md`) and the orchestrator
server in `equivalence/eq/adapters/server.py` — Homely connects *out* to this
server; the tools forward protocol commands to the live app.

## Easy path

1. **Start the MCP server** (stdio, what Claude/ChatGPT desktop expect):

   ```bash
   ./homely-mcp/run.sh
   ```

   It prints the WS port on stderr, e.g. `ws://127.0.0.1:9529`.

2. **Launch Homely pointed at it** (separate terminal):

   ```bash
   HOMELY_AUTOMATION_PORT=9529 npm --prefix homely run tauri dev
   # or on the built app: HOMELY_AUTOMATION_PORT=9529 ./homely/target/release/homely
   ```

   To drive the *original* instead, point the sh3d-driver at the same port.

3. **Connect your assistant** — add `homely-mcp/claude_desktop_config.json` to
   Claude Desktop, or `homely-mcp/mcp.json` to a ChatGPT connector. Then say:
   *"Design a 3-bedroom house and show me a 3D screenshot."*

For cloud ChatGPT (no local stdio), expose HTTP instead:

```bash
HOMELY_MCP_HTTP_PORT=8080 ./homely-mcp/run.sh
```

and point the connector at `http://127.0.0.1:8080/mcp`.

## Tools

| Tool | Purpose |
|------|---------|
| `homely_status` | Which app is connected + the WS port |
| `reset_home` | New empty home |
| `get_home_state` | Full `NormalizedHomeState` JSON |
| `screenshot` | Offscreen plan/3D PNG (returned as an image) |
| `list_furniture` | Catalog items |
| `add_furniture` | Place a catalog item by id (cm coords) |
| `draw_rectangular_room` | Closed 4-wall rectangle (one undo) |
| `select_tool` / `click` / `drag` / `key` / `set_magnetism` | Plan interaction |
| `set_camera` / `camera_preset` | 3D view |
| `undo` / `redo` | History |

Units: centimeters for lengths, degrees for angles, plan coords x-right / y-down.

## Known limits (see parity audit)

The current Homely clone implements the wall tool, furniture placement, camera
presets, undo/redo, state export and screenshots. **Not yet wired** to the
automation protocol: room floor/ceiling editing, doors/windows cutouts, levels,
dimension lines, labels, `modify_selected`, and `.sh3d` save/open round-trip.
The `draw_rectangular_room` helper draws walls only (no auto floor). These are
tracked as handler gaps and can be added using the already-present `core/model.ts`
operations.
