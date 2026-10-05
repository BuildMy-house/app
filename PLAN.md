# buildmy-house-app — Next-Level UX Claim Board

Open-ended improvement mandate (dispatched 2026-10-05): make the app more
user-friendly, realistic, and fun for both human users (UI/UX) and agent
users (the `buildmyhouse` MCP tool surface). Two tracks, interleaved by
priority, not sequenced phases.

> Claim rule: Steward's `claim_work` is the real gate (see
> `.agents/agent-manager.md`). This board's `Claimed-by`/`Status` columns are
> a human-readable mirror only. Status moves
> `todo → claimed → in_progress → review → done`. Only the manager sets
> `done`, after independent verification (re-run DoD, diff review, and for
> UI tickets, live exercise via the `buildmyhouse` MCP and/or dev server).

**Known MCP limitation, baked into ticket scope below (Steward memory
`buildmyhouse:warning_buildmyhouse_mcp_screenshot_tool_strips__6DFFDC57`):**
`screenshot`'s offscreen rasterizer (`mcp/render_scene.ts`) deliberately
strips `catalogId`/`modelPath` before rendering furniture (it is a pure
software rasterizer, not a real Three.js/WebGL renderer, so it cannot load
GLB geometry) — every furniture item currently renders as an identical grey
box. T3 below scopes a cheap, real improvement (deterministic per-item
color + label) without attempting real model loading in Node.

## Claim Board — Wave 1 (dispatched 2026-10-05)

| Ticket | Title | Track | Deps | Owner paths | Priority | Claimed-by | Status | Notes |
|--------|-------|-------|------|--------------|----------|------------|--------|-------|
| T1 | `validate_scene`/`scene_summary`: detect furniture-overlapping-wall, furniture outside every level's rooms AND outside the whole footprint, duplicate ids, self-intersecting room polygons — promote these to real `errors` (not just warnings) alongside the existing no-walls/no-rooms checks | agent | — | `app/mcp/scene_analysis.py`, `app/mcp/test_scene_analysis.py` | P0 | agent-manager | done | Shipped `3721ae6` — dup-id, self-intersecting-room errors + room-overlap warning added to `analyze_home()`/`validate_home()`. 7/7 new+existing pytest pass. Verified via pytest only (no `buildmyhouse` MCP binding in this manager session to live-exercise `validate_scene`). |
| T2 | Expose the existing `FurnitureCatalog.search()`/category filter (already used by the UI's catalog panel, `src/ui/catalog-panel.ts:305`) through the `list_catalog` wire protocol and the MCP `list_furniture` tool (`query`, `category`, optional `limit` params); make `resolvePlacement`'s "unknown catalogId" error suggest close matches via the same `search()` instead of a bare error string | agent | — | `app/src/core/catalog-service.ts`, `app/src/automation/homely-handler.ts`, `app/mcp/server.py` (`list_furniture`), `app/mcp/test_build_house.py` | P0 | agent-manager | done | Shipped `c23b710` — `list_catalog`/`list_furniture` now take `query`/`category`/`limit`; `resolvePlacement` suggests close-match catalogIds. `npm run check` clean, 69/69 catalog-filtered vitest + 3/3 pytest pass. |
| T3 | `render_scene.ts` offscreen rasterizer: give each distinct `catalogId` a deterministic color (hash catalogId → HSL) instead of flat grey, and draw a short text label (first few chars of `name`) inside each furniture footprint in the `plan` view, so agents can visually distinguish items in a cheap `screenshot` call without needing `render_photoreal` | agent | — | `app/mcp/render_scene.ts` | P1 | agent-manager | done | Shipped `222988b` — `catalogColor()` (FNV-1a hash → golden-ratio hue) + label pass in plan/3D box rendering; doors/windows excluded. New vitest spec passing (3/3); full suite 971 passed/1 skipped. |
| T4 | Replace the single static first-run empty-state message with a progressive onboarding checklist (draw walls → add a room → place furniture → switch to 3D view), each step auto-checked off as the user actually performs it, dismissible, never reappears once dismissed or once the plan has content | human | — | `app/src/ui/plan-empty-state.ts`, `app/src/main.ts` (wiring only, `createPlanEmptyState` call site at line ~105) | P0 | agent-manager | done | Shipped `48d3981` — 4-step onboarding checklist (walls → door/window → furnish → 3D view) replacing static message; step-1 auto-completes on first geometry; dismiss button; public API (`setEmpty`/`setSignedIn`) unchanged so `main.ts` wiring untouched. 7/7 component tests pass; full e2e suite 104/104 passed on push. |
| T5 | Catalog panel grid tiles: show width×depth×height (cm) and category inline on every tile (not just on hover/click), so users can judge fit before dragging an item onto the plan | human | — | `app/src/ui/catalog-panel.ts` | P1 | agent-manager | done | Shipped `027759e` — category badge pill + `W×D×H cm` inline on every tile. cm chosen directly (no existing cm→display-unit helper in `src/ui`/`src/core`; the one candidate, `formatLength` in `plan/renderer.ts`, is private/meters-only and would lose precision for furniture). New component test passing; full suite 963+ passed. |

## Backlog — not dispatched this round

| Ticket | Title | Track | Priority | Notes |
|--------|-------|-------|----------|-------|
| T6 | Live dimension readout while drawing a wall (length/angle tooltip following the cursor, mirroring the magnetism/snap feedback already in `src/plan/engine.ts`) | human | P2 | Needs a closer look at `engine.ts`'s input-handling loop before scoping a precise owner-file list; not investigated deeply enough this round to hand to a worker unsupervised. |
| T7 | Lighting/materials realism pass for the live Three.js viewport (beyond the LOD/HDRI work already merged — `documents/plans/realtime-3d-view-quality-pipeline`) | human | P2 | Heavy recent investment already landed here (HDRI environment, PBR maps, LOD culling, instanced furniture). Needs a fresh visual audit (screenshot/render_photoreal comparison against reference photos) before writing a scoped ticket — avoid duplicating recently-shipped work. |
| T8 | Batch/transactional furniture operations for agents (e.g. `move_furniture_batch`, `delete_many`) distinct from `build_house`'s already-batch-capable full-plan rebuild | agent | P2 | `build_house` already accepts a full plan in one call for *construction*; the gap (if any) is in bulk *editing* an existing scene without a full rebuild — needs confirmation this is actually missing before ticketing. |

## Verification notes (for the manager, per ticket)

- T1/T2: `cd app/mcp && python3 -m pytest test_scene_analysis.py test_build_house.py -q` (install `requirements.txt` into a throwaway venv first if not already present).
- T2 (TS side): `cd app && npm run test -- catalog` then `npm run check`.
- T3: `cd app && npm run test -- render_scene` if a vitest spec exists for it, else exercise directly via the `buildmyhouse` MCP `screenshot` tool on a multi-furniture demo scene and inspect the PNG.
- T4/T5: `cd app && npm run check && npm run test` then live-exercise via `npm run dev` (first-run with an empty plan for T4; catalog panel open for T5) — these are UI-facing, live verification is mandatory, not optional.
- All: `npm run lint` must stay clean; no files outside each ticket's owner paths.
## Claim Board — Wave 2 (dispatched 2026-10-06)

Live-use bug reports from Nahar, each its own Steward ticket (claim/lock/
verify), root-caused by reading code first, fixed at the root cause,
independently verified (diff review + re-run DoD, not trusting worker
self-report), committed separately.

| Ticket | Title | Owner paths | Claimed-by | Status | Notes |
|--------|-------|--------------|------------|--------|-------|
| T9 | Room-closing false wall: clicking back inside the interior of an already-drawn room (not exactly on the start vertex) to close the wall loop was adding a spurious wall instead of finishing the room | `app/src/plan/engine.ts`, `app/tests/plan-engine.test.ts` | agent-manager | done | Shipped `e456743` (initial fix) + `5f2c9c5` (regression guard, bundled with T11 due to a manager git-amend mistake — see commit message). Root cause: `singleClick()`'s wall-tool branch had no "interior click closes the loop" path — a plain click anywhere just committed another wall segment from the chain head. Fix: when the chain has ≥2 committed walls and the click point lies inside the polygon the chain would enclose (reusing the existing `pointInPolygon` ray-cast helper), close the loop back to the chain's first vertex instead of extending it; excluded clicks within `ENDPOINT_HIT_RADIUS` of the start vertex so the existing dblclick-finalization flow (a plain `click` always fires before `dblclick`) is untouched. New regression test added (triangle via 3 clicks + 1 interior click closes instead of adding a 4th wall). Caught and fixed a real regression via the repo's pre-push e2e hook (3 `room-autodetect.spec.ts` failures) before any push — final state: 109 e2e passed/6 skipped/0 failed, 90/90 engine unit tests. |
| T10 | Tool toggling wasn't intuitive: the V/W keyboard shortcuts advertised in the toolbar's own tooltips did nothing | `app/src/main.ts`, `app/tests/tool-shortcuts.test.ts` | agent-manager | done | Shipped `3553480`. Root cause: toolbar tooltips said "V" (selection) / "W" (wall) but no keydown handler existed for them — only the toolbar buttons themselves worked. Fix: factored the existing button-click tool-switch sequence into a shared `switchTool()` helper and added a keydown case for `v`/`w` (guarded against ctrl/meta/alt and focused text inputs, so ctrl+v paste is unaffected) that calls the same helper, so keyboard and mouse paths behave identically. New test file covers both shortcuts plus input-focus suppression. 977 passed/1 skipped, `npm run check` clean. |
| T11 | Furniture selection scrolls to top instead of highlighting: clicking a catalog item reset the catalog panel's scroll position instead of just visibly marking it selected | `app/src/ui/catalog-panel.ts`, `app/tests/catalog-panel-status.test.ts` | agent-manager | done | Shipped bundled in `5f2c9c5` (see T9 note — a manager git-amend mistake merged this with T9's regression guard into one commit; message updated to honestly describe both). Root cause: `arm()`/`disarm()` called `renderGrid()`, a full DOM teardown/rebuild of the virtualized card grid, which reset `scrollTop` to 0 as a side effect — the "highlight" was really a full re-render, not a style toggle. Fix: added `syncArmedClass()` which just toggles the `.armed` CSS class (plain class selector, already defined in `style.css`) on the already-mounted card elements via the existing `cardEls` Map, and `arm()`/`disarm()` now call that instead of `renderGrid()`. New scroll-then-arm/disarm test asserts `scrollTop` is unchanged and `.armed` presence/absence is correct. 74 passed on catalog-filtered test run. |
| T12 | Wall material assignment doesn't visibly apply or persist | TBD — investigation in progress | agent-manager | in_progress | Added mid-wave per explicit coordinator instruction (2026-10-06): find the wall material-assignment UI control, the wall model's material-storage field, and the renderer's read-back path; reproduce the failure; root-cause it (set-but-not-read by renderer? not persisted/saved? UI not wired to the right handler? overwritten by re-render?); fix; verify by actually applying a material to a wall and confirming it renders AND persists (save/reload or undo/redo), not just a unit test. |

### Verification notes — Wave 2

- T9: `npm run test -- plan-engine` (90/90), `npm run check`, then `git push origin main` to trigger the repo's pre-push e2e hook (Playwright) — do not consider a wall-drawing-engine change verified without this, since a prior regression here was only caught by the hook.
- T10: `npm run test -- tool-shortcuts`, `npm run check`.
- T11: `npm run test -- catalog`, live-exercise via `npm run dev` (scroll the catalog, click an item, confirm scroll position is unchanged and the item is visibly highlighted).
- T12: live-exercise is mandatory — apply a material to a wall via the real UI/MCP path, screenshot/inspect the render, then reload (or undo/redo) and confirm the material is still applied. A passing unit test alone does not satisfy this ticket's DoD.
