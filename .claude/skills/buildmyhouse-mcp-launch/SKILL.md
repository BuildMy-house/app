---
name: buildmyhouse-mcp-launch
description: Launch a live app session so the buildmyhouse MCP tools (screenshot, click, drag, get_home_state, etc.) have something to connect to and drive. Use this whenever a buildmyhouse MCP tool call fails or would fail with "no app connected" / homely_status shows an empty connected list — before reporting the MCP tools as unavailable.
---

# buildmyhouse MCP launch path

The `buildmyhouse` MCP server (`app/mcp/server.py`) does not launch or
control the app itself. It only listens on a local WebSocket
(`ws://127.0.0.1:9529` by default) and waits for an app instance to
connect **out** to it (see `app/src/automation/README.md` for the
security rationale — this is loopback-only by design and must not be
made configurable to accept remote hosts).

That means every `mcp__buildmyhouse__*` tool call is a no-op / error
until some running app instance has connected. In this sandboxed
environment there is normally no Tauri GUI and no `claude-in-chrome`
extension available, so a plain browser-in-headless-Chromium session is
the reliable way to get a connection.

## Steps

1. **Check first** — don't launch anything before confirming it's actually needed:
   ```
   mcp__buildmyhouse__homely_status
   ```
   If `connected` already includes `"homely"` (or `"buildmyhouse"`), skip
   straight to using the tools.

2. **Start the vite dev server** (from `app/`), backgrounded:
   ```bash
   cd app && npm run dev > /tmp/.../vite-dev.log 2>&1 &
   ```
   Confirm it's up and note the actual port (usually `1420`, but can
   shift if that port is taken — read the log rather than assuming):
   ```bash
   grep -m1 'Local:' /tmp/.../vite-dev.log
   ```
   The app's automation client defaults to `DEFAULT_AUTOMATION_PORT =
   9529` (`app/src/main.ts`), which matches the MCP server's default
   `HOMELY_MCP_PORT`. A plain dev-server page load auto-connects with no
   extra env vars or query params needed.

3. **Open the app in headless Chromium via Playwright** (already a
   dependency in `app/node_modules` — no install needed). Must be run
   from inside `app/` so Node's ESM resolution finds the package;
   running the same script from `/tmp` or the scratchpad fails with
   `ERR_MODULE_NOT_FOUND`:
   ```js
   // app/scripts/open_app_for_mcp.mjs (or a scratch file inside app/)
   import { chromium } from 'playwright'
   const browser = await chromium.launch({ headless: true })
   const page = await browser.newPage()
   page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()))
   page.on('pageerror', (err) => console.log('[pageerror]', err.message))
   await page.goto('http://localhost:1420/', { waitUntil: 'load' })
   await page.waitForTimeout(3000)
   console.log('loaded, keeping open')
   await new Promise(() => {}) // keep the browser (and WS connection) alive
   ```
   ```bash
   cd app && node ./scripts/open_app_for_mcp.mjs > /tmp/.../open_app.log 2>&1 &
   disown
   ```

4. **Re-check the connection**:
   ```
   mcp__buildmyhouse__homely_status
   ```
   Should now report `connected: ["homely"]`. If not, tail
   `open_app.log` for `[pageerror]`/`[console]` output — a JS error on
   load usually means the dev server isn't actually serving the built
   app yet (race between steps 2 and 3).

5. Drive normally with `mcp__buildmyhouse__*` tools. Kill both
   background processes (`npm run dev` and the Playwright script) when
   done — they hold the WS connection open indefinitely otherwise.

## Known caveat: `screenshot`/`screenshot_views` do not capture the live browser

`mcp__buildmyhouse__screenshot` does **not** rasterize the connected
browser session. `app/mcp/server.py`'s `_render()` spawns a separate
`npx tsx app/mcp/render_scene.ts` subprocess that reimplements plan and
3D rendering independently from just the home-state JSON — a
verification-only renderer, not the real app's rendering path
(`app/src/automation/capture.ts` / `app/src/plan/renderer.ts` /
`app/src/view3d/scene.ts`, which is what a live user session actually
uses). Its plan rasterizer used to ignore furniture `angleDeg` entirely
(fixed in commit `d13b560`); its 3D rasterizer reuses the real
`buildScene` so orientation there is correct, but has no alpha/
transparency support, so opaque walls will often occlude interior
furniture in a 3D screenshot regardless of camera angle — a `set_camera`
inside the room's footprint may be needed to see past them, or verify
3D-only concerns by reading `scene.ts`/tests instead of relying on the
screenshot tool.

If a future bug report says "the screenshot tool shows X but the app
shows Y," suspect a divergence between `render_scene.ts` and the real
app rendering code first, not a live-state bug.
