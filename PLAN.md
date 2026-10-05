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
