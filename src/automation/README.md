# Automation (client side)

Homely's plan/3D engine is remotely controllable over the WebSocket protocol
defined in `docs/specs/ws-protocol.md` v1. This directory is the **app side**:

- `client.ts` — `AutomationClient`: browser WS client that connects OUT to an
  orchestrator, plus the `HOMELY_AUTOMATION_PORT` / `?automationPort=` seams.
- `homely-handler.ts` — `HomelyCommandHandler`: executes the command set
  (draw, select, modify, undo/redo, save/open, screenshot, …) against the live
  store.
- `capture.ts` — offscreen plan/3D rasterization for the `screenshot` command.

Homely itself **never listens on a socket**. The orchestrator servers live
elsewhere and Homely connects out to them:

| Server | Bind | Notes |
|---|---|---|
| `equivalence/eq/adapters/server.py` (`AutomationServer`) | `127.0.0.1` by default | Used by `qa-loop/run.py` and the equivalence runner with the default host. |
| `homely-mcp/server.py` | `127.0.0.1` by default (`HOMELY_MCP_HOST` to override) | MCP bridge for AI agents; stdio transport, HTTP only behind `HOMELY_MCP_HTTP_PORT`. |
| `homely/src/dev/mock-orchestrator.ts` | explicit `127.0.0.1` | Dev/test stand-in only, never shipped. |

The Tauri shell (`homely/src-tauri/src/lib.rs`) opens no port either — it only
reads `HOMELY_AUTOMATION_PORT` and hands the number to the webview.

## Security (M17 audit)

This setup is loopback-only **by design**, and that is what makes it safe:

- **The client refuses every non-loopback orchestrator.** `client.ts` builds
  `ws://127.0.0.1:<port>` and hard-rejects any URL that does not match
  `^ws://127\.0\.0\.1:\d+$`. All port seams (`?automationPort=`, the Tauri
  env passthrough, `HOMELY_AUTOMATION_PORT`) set a **port only** — there is no
  code path that can point the app at a remote host. Do not "fix" this by
  making the host configurable; that would let a remote party drive the app.
- **There is no authentication/token, and none is needed under this model.**
  Commands flow orchestrator → app only; the app never accepts inbound
  commands from anywhere else. Whoever can reach an orchestrator's port can
  only register a *fake adapter session* (spoof/DoS of QA or MCP tooling) —
  they cannot send commands to the user's running app. Controlling the app
  requires controlling the orchestrator *process*, which requires local code
  execution, which is outside the threat model for a local design app.
- **No command touches the OS filesystem.** `save`/`open` with a `path`
  persist to `localStorage` (`src/core/project-store.ts`); the WebView sandbox
  has no disk access. Worst case, a command mutates or exports the in-memory
  home design.
- **LAN access is an explicit opt-in.** `homely-mcp` exposes
  `HOMELY_MCP_HOST` (and `HOMELY_MCP_HTTP_PORT` for the streamable-HTTP MCP
  transport). Both default to loopback; network exposure requires setting env
  vars deliberately and should only be done on a trusted network, since
  sessions are unauthenticated.
