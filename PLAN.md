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

## Phase: PM-agent chat widget (2026-10-05)

Dispatched by `agent-manager` (Steward manager task
`manage-buildmy-house-app-chat-widget-board-wave-1`). App-side half of a new
feature: an in-app chat widget backed by a new, isolated "pm-agent" in
`company-os` (tracked on that repo's own `PLAN.md`, Phase: PM-agent). The
widget must carry the real logged-in user's identity — no anonymous
sessions — so filed feedback has real provenance.

**Dependency across repos:** the widget's live backend (pm-agent's
`/chat` HTTP/SSE surface, `company-os` tickets PM-C/PM-E/PM-F) is not yet
built. A1 below is scoped to be buildable and independently testable
against a documented contract/mock now; do not wire it to a real
`pm-agent.buildmy.house` URL or enable it for real users until the
company-os side is verified live — ship it behind a feature flag / dev-only
toggle, consistent with this repo's "prod deploy is automatic on push to
main" behavior (Steward memory
`buildmyhouse:pattern_app_buildmy_house_app_prod_deploy_is_aut_78D015DB`) —
there is no staging gate here, so an unflagged widget pointed at a
non-existent backend would go live immediately on merge.

> Claim rule: Steward's `claim_work` is the real gate. Status moves
> `todo → claimed → in_progress → review → done`. Only the manager sets
> `done`, after independent verification (re-run DoD, diff review, live
> exercise via `npm run dev`).

| Ticket | Title | Deps | Owner paths | Claimed-by | Status | Notes |
|--------|-------|------|--------------|------------|--------|-------|
| A1 | Chat widget UI component (behind a dev-only feature flag) | — | `app/src/ui/chat-widget.ts` (new), a feature-flag check (grep existing flag patterns in `src/` first — mirror whatever convention already exists, e.g. a `localStorage`/env-based toggle; if none exists, gate behind `import.meta.env.DEV` plus an explicit opt-in localStorage key so it never silently appears for real users), `src/main.ts` (wiring only, mirror how `plan-empty-state.ts` is wired per the T4 row above) | agent-manager | todo | Floating chat panel (open/close toggle, message list, input box) that connects over SSE/WebSocket to a pm-agent HTTP surface — for this ticket, point it at a small local mock server (`app/server/test/` style, or a trivial `vitest`-mocked fetch) rather than a real `pm-agent.buildmy.house` URL, since that backend does not exist yet (see company-os PM-C/PM-F). Must read the real logged-in user's id from whatever `app/server`'s auth already exposes client-side (grep `src/` for how the client currently knows the logged-in user — e.g. a stored JWT or `/me` call hitting `server/src/auth.ts`'s `meHandler`) and include it on every outgoing message; never send an anonymous/placeholder user id. DoD: component test (mirror the T4 onboarding-checklist test's structure) covering open/close, send/receive against the mock, and the real-user-id requirement (test must fail if no logged-in user id is available rather than silently sending null); `npm run check && npm run test` clean; `npm run lint` clean; live-exercise via `npm run dev` with the feature flag enabled. |
| A2 | Server-side chat proxy: JWT-verified relay to pm-agent | A1, company-os PM-C/PM-F (cross-repo; do not dispatch until pm-agent has a reachable `/chat` endpoint — confirm via the company-os board before claiming this) | `app/server/src/chat.ts` (new), `app/server/src/app.ts` (route wiring only — grep for how other routes mount `requireAuth`, mirror exactly), `app/server/test/chat.test.ts` (new) | — | todo | New authenticated route (reuse `requireAuth` from `server/src/auth.ts` verbatim — do not reimplement JWT verification) that takes a chat message from the already-authenticated `req.userId`, forwards `{app_user_id: req.userId, message}` to the pm-agent's HTTP surface (URL from an env var, e.g. `PM_AGENT_URL`, never hardcoded), and relays the reply back (proxy the SSE stream if pm-agent exposes one, else a plain JSON round-trip is fine for v1 — do not over-build streaming if the pm-agent side ships JSON-only first). This is the one place the real `req.userId` (not client-supplied) reaches pm-agent — never trust a user id the client sends directly, only the one `requireAuth` derived from the verified JWT. DoD: `cd app/server && npm test -- chat` green (mock pm-agent's HTTP endpoint in the test, no live network call); confirm no other existing route/test regressed. **Do not claim/dispatch this ticket until the company-os PM-agent board shows PM-C done and PM-F at least dry-run-validated** — it has a real cross-repo dependency, unlike A1. |

**Dispatch wave 1 (this run):** A1 only — self-contained, mocked backend,
no live user-facing wiring (feature-flagged). A2 stays `todo`, fully
scoped, blocked on the company-os side landing first.
