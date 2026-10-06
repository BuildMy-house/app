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
| A1 | Chat widget UI component (behind a dev-only feature flag) | — | `app/src/ui/chat-widget.ts` (new), a feature-flag check (grep existing flag patterns in `src/` first — mirror whatever convention already exists, e.g. a `localStorage`/env-based toggle; if none exists, gate behind `import.meta.env.DEV` plus an explicit opt-in localStorage key so it never silently appears for real users), `src/main.ts` (wiring only, mirror how `plan-empty-state.ts` is wired per the T4 row above) | agent-manager | done | Shipped — `src/ui/chat-widget.ts` (floating panel, open/close toggle, injectable `PmAgentClient` seam, `createFetchPmAgentClient`), feature flag `isPmAgentChatEnabled()` mirrors `src/config/feature-flags.ts`'s `VITE_`-env convention (`VITE_ENABLE_PM_AGENT_CHAT==='true'`, default OFF — this repo auto-deploys to prod on push, so it must never default on), `userIdFromToken()` reads the real auth JWT `sub` claim (same id `requireAuth`/`meHandler` derive server-side); refuses to send with no error swallowed when no logged-in user id is available (asserted by test, never falls back to a placeholder). Wired into `src/main.ts` next to the auth block, mirroring the `createPlanEmptyState` call-site style. No real `pm-agent.buildmy.house` URL anywhere — only this app's own not-yet-built `/api/chat` proxy path (ticket A2). 14/14 new component tests pass; independently re-verified by the manager: `npm run check` clean, `npm run test -- chat-widget` 14/14 pass, `npm run lint` clean. |
| A2 | Server-side chat proxy: JWT-verified relay to pm-agent | A1, company-os PM-C/PM-F (cross-repo; do not dispatch until pm-agent has a reachable `/chat` endpoint — confirm via the company-os board before claiming this) | `app/server/src/chat.ts` (new), `app/server/src/app.ts` (route wiring only — grep for how other routes mount `requireAuth`, mirror exactly), `app/server/test/chat.test.ts` (new) | — | todo | New authenticated route (reuse `requireAuth` from `server/src/auth.ts` verbatim — do not reimplement JWT verification) that takes a chat message from the already-authenticated `req.userId`, forwards `{app_user_id: req.userId, message}` to the pm-agent's HTTP surface (URL from an env var, e.g. `PM_AGENT_URL`, never hardcoded), and relays the reply back (proxy the SSE stream if pm-agent exposes one, else a plain JSON round-trip is fine for v1 — do not over-build streaming if the pm-agent side ships JSON-only first). This is the one place the real `req.userId` (not client-supplied) reaches pm-agent — never trust a user id the client sends directly, only the one `requireAuth` derived from the verified JWT. DoD: `cd app/server && npm test -- chat` green (mock pm-agent's HTTP endpoint in the test, no live network call); confirm no other existing route/test regressed. **Do not claim/dispatch this ticket until the company-os PM-agent board shows PM-C done and PM-F at least dry-run-validated** — it has a real cross-repo dependency, unlike A1. |

**Dispatch wave 1 (this run):** A1 only — self-contained, mocked backend,
no live user-facing wiring (feature-flagged). A2 stays `todo`, fully
scoped, blocked on the company-os side landing first.

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
| T12 | Wall material assignment doesn't visibly apply or persist | `app/src/ui/properties-panel.ts`, `app/tests/properties-panel.test.ts`, `app/e2e/wall-material-assignment.spec.ts` | agent-manager | done | Shipped `53ecc67`. Root cause: the per-wall L/R Texture dropdown silently excluded every catalog material whose `wallUsage` didn't match the wall's auto-derived exterior/interior classification -- a freestanding wall with no enclosing room defaults to 'exterior', hiding every interior-only material (carpet, wood-oak, plaster-white) from the list entirely with zero indication why. Model/renderer (full-rebuild AND scene-delta remesh paths) were already correct -- confirmed via direct repro tests before finding the UI bug. Fix: wallUsage now only annotates the option label as a hint, never removes the option. Verified live via Playwright (not just unit test): previously-hidden option now present, commits to the model, 3D mesh's material actually gets the texture map, survives undo/redo. |
| T13 | CI red on main (blocking prod auto-deploy): T9's interior-click chain-close falsely closed the loop for clicks merely grazing an already-drawn chain edge | `app/src/plan/engine.ts`, `app/tests/plan-engine.test.ts` | agent-manager | done | Shipped `9cb6e20` (dispatched to `zai-coding-plan/glm-5.3-flash` worker, independently re-verified by the manager). Root cause: T9's `pointInPolygon` chain-close check (singleClick(), engine.ts) is standard ray-casting, which is implementation-defined on a polygon boundary -- `e2e/wall-loop-closing-precision.spec.ts`'s "far from the origin" click landed exactly on the chain's top edge (same y as two committed vertices) and ray-casting resolved that boundary point to "inside", incorrectly closing the loop ~30px from the start vertex, well beyond the intended zoom-aware snap radius. Fix: added `minDistanceToPolygonEdges()` (reusing the existing `closestPointOnSegment` helper already used by `wallBodySnapAt`) and now requires both `pointInPolygon(...)` true AND distance to every polygon edge (including the implicit closing edge back to the first vertex) > `ENDPOINT_HIT_RADIUS` before treating a click as a genuine interior close. Manager independently re-ran: `npx vitest run tests/plan-engine.test.ts` 91/91 pass (incl. new regression test + original T9 test unaffected), `npx playwright test e2e/wall-loop-closing-precision.spec.ts` 3/3 pass (the previously-failing test now passes), `npm run check` clean, full `npx vitest run` 993 passed/1 skipped, full `npx playwright test` 110 passed/6 skipped/0 failed. Pushed to `origin/main` at `9cb6e20`; CI run 37360885119 green (all 7 jobs), deploy workflow run 37361579110 succeeded. |

### Verification notes — Wave 2

- T9: `npm run test -- plan-engine` (90/90), `npm run check`, then `git push origin main` to trigger the repo's pre-push e2e hook (Playwright) — do not consider a wall-drawing-engine change verified without this, since a prior regression here was only caught by the hook.
- T10: `npm run test -- tool-shortcuts`, `npm run check`.
- T11: `npm run test -- catalog`, live-exercise via `npm run dev` (scroll the catalog, click an item, confirm scroll position is unchanged and the item is visibly highlighted).
- T12: live-exercise is mandatory — apply a material to a wall via the real UI/MCP path, screenshot/inspect the render, then reload (or undo/redo) and confirm the material is still applied. A passing unit test alone does not satisfy this ticket's DoD.

### Verification notes — T13

- T13: `npx vitest run tests/plan-engine.test.ts`, `npx playwright test e2e/wall-loop-closing-precision.spec.ts`, `npm run check`, full `npx vitest run` and full `npx playwright test` — all re-run and confirmed green by the manager directly (not just worker self-report) before marking done. CI run https://github.com/BuildMy-house/app/actions/runs/37360885119 watched to green via `gh run watch`.

## Audit — verification + fresh-findings pass (dispatched 2026-10-06)

Requested by Nahar: "audit the app, ensure that you can [use it], and see
what else can be improved" — not another feature wave. Two parts: (1)
actually verify the app works end-to-end (human UI path and agent/MCP
path) rather than trusting prior waves' test suites alone, (2) look for
anything newly broken/confusing and any code-health/agent-ergonomics gaps
beyond the existing T6-T8 backlog.

### Part 1 — Verification results

**Agent/MCP round-trip — actually exercised live, not just unit-tested.**
A dev server (`npm run dev`, vite on port 1420) plus a headless
Playwright-driven browser connected to the app's automation WebSocket
bridge, with the `buildmyhouse` MCP tools bound in a live session. Real
tool calls made and their results inspected directly:

- `homely_status` — correctly reports `connected: []` before the browser
  attaches, `connected: ["homely"]` after.
- `mcp_identity` — returns `{user, transport, authenticated}` as documented.
- `list_furniture` with a `query` filter (`"sofa"`) and separately with a
  `category` filter (`"Bedroom"`) — both returned correctly filtered
  results (confirms wave 1's T2 fix is live end-to-end, not just
  unit-tested).
- `build_house` with a real multi-room plan (2 rooms, 7 walls, doors,
  windows, furniture) — built successfully; `validate_scene` on the
  resulting scene returned `valid: true`, zero errors/warnings, correct
  counts/bounds/room areas.
- Two **intentionally malformed** `build_house` calls to test agent error
  recovery: (a) a door referencing a non-existent wall with neither
  `wallKey` nor `wallId` — server correctly rejected with
  `"doors item requires wallKey or wallId"`; (b) an unknown `catalogId`
  (`sh3d-full#Nobody#ghostItem`) — server rejected with
  `"INVALID_PARAMS: unknown catalogId: ... Did you mean:
  sh3d-full#Dingenskirchen#pinewoodRackFullHeightHalfWidth, ..."`.
  **Confirms an agent can recover from a bad call without guessing** —
  both error messages are specific and actionable (name the missing
  field, or suggest close-match catalogIds via wave 1's T2 fix) rather
  than a bare/generic failure.
- `scene_summary` — matches `validate_scene`'s embedded summary, correct.
- `screenshot` in both `plan` and `3d` views — both produced real,
  non-trivial PNGs (3d view screenshot confirmed to actually render the
  built scene, not a blank/error image).

**Human/UI path**: not separately hand-driven this round (time went to the
live MCP round-trip above instead) — but the pre-push e2e suite (105
Playwright specs covering draw/close-room/doors-windows/materials/
furniture/undo-redo/save-reload/3D-view/tool-switching) was re-run in full
immediately before landing T14 below and passed 105/105 with zero
failures, which is a direct, current (not stale) signal that wave 1/2/T13
all still hold together with no regressions.

**Prod deploy**: confirmed `app.buildmy.house`'s current deploy actually
reflects the latest `main`, not a stale container — the deploy workflow's
own job log shows `actions/checkout@v4` fetching and building exactly
commit `8bf955eaebe1da62a1f17025e824ba6a79d8fff5` (T14 below), and the
deploy run (https://github.com/BuildMy-house/app/actions/runs/37455739025)
completed successfully.

**Stale-bug-memory triage** (three ambiguous Steward memories checked
against current code/CI, not re-opened as findings since all are already
resolved):
- `buildmyhouse:bug_prod_app_container_never_receives_luxcor_CB189933` —
  stale; `.github/workflows/deploy-app.yml`'s candidate container run
  already includes `LUXCORE_WORKER_URL` and `--env-file
  /home/ubuntu/buildmyhouse-mcp.env`.
- DianaWindow glass bug — stale; fixed by commit `252c61a` (re-ingest with
  glass fix), which postdates the memory.
- Roof/ceiling `activeLevel===null` auto-hide pattern — already
  incorporated; `src/view3d/scene.ts`'s `shouldShowCeiling`/
  `matchesLevel`/`findLevelBelowId` helpers explicitly treat
  `activeLevel === null` as the default case, and numerous later commits
  (`fece8d0`, `672bb5b`, `47cccde`, `4d6bffc`, `011cf96`, `ba4cc89`, etc.)
  already build on this.

### Part 2 — New ticket shipped this round

| Ticket | Title | Owner paths | Claimed-by | Status | Notes |
|--------|-------|--------------|------------|--------|-------|
| T14 | `select_object` accepts a list of ids for agent batch edit/delete (closes backlog T8) | `app/src/automation/homely-handler.ts`, `app/mcp/server.py`, `app/tests/handshake.test.ts`, `app/mcp/test_build_house.py` | agent-manager | done | Shipped `8bf955e`. Root cause: `select_object` hardcoded a single id into `setSelection([id])` even though `setSelection` already accepts an arbitrary array (proven by the neighboring `select_all` case). This meant an agent could only multi-select via `select_all` (literally everything) or one object at a time — no way to batch move/delete/recolor an arbitrary subset without N round trips. Fix: `select_object` now accepts either `objectId: string` (unchanged) or a new `objectIds: string[]` (validated non-empty array of non-empty strings), passing the full array to `setSelection`. `modify_selected`/`delete_selection` already iterate `home.selection` as an array, so batch edit/delete now works for an arbitrary subset with zero further changes — confirmed by new test coverage, not just code reading. Independently re-verified by the manager (diff review of all 4 touched files + full DoD re-run): `npm run check` clean, `npx vitest run` 995 passed/1 skipped, `npm run lint` clean, `cd mcp && python3 -m pytest -q` 12 passed. Pushed to `origin/main` (`ef31a4c..8bf955e`); CI run https://github.com/BuildMy-house/app/actions/runs/37455358575 green (all jobs incl. both e2e shards); deploy run https://github.com/BuildMy-house/app/actions/runs/37455739025 succeeded, confirmed deploying this exact commit SHA. |

### Part 2 — Code-health items checked and confirmed fine (no action needed)

- **`pointInPolygon`/`minDistanceToPolygonEdges`/`wallBodySnapAt` duplication concern — investigated, not a real duplication.** `minDistanceToPolygonEdges` (added in T13, `src/plan/engine.ts:2295`) and `wallBodySnapAt` (`src/plan/engine.ts:2093`) already share the same underlying primitive (`closestPointOnSegment` + `distance`) — T13's helper is properly factored on top of the existing segment-distance utility, not a parallel reimplementation. No consolidation needed.
- **`validate_scene`'s `errors`/`warnings` array overlap — investigated, confirmed intentional/tested, not a bug.** `validate_home()` (`mcp/scene_analysis.py`) deliberately promotes a filtered subset of `analyze_home()`'s warnings into a separate `errors` array while leaving the same message in `warnings` too; `mcp/test_scene_analysis.py` has explicit dual-array assertions for this. Initially flagged as a T15 candidate, corrected after checking existing tests — no edit made.
- **Knip (`npm run knip`) unused-export/unused-file findings — confirmed false positives**, not real dead code: exports used only within their own file (knip flags the `export` keyword as unnecessary even though the binding is actively used), and standalone CLI/script entry points never statically imported by anything else.

### Part 2 — New backlog items (documented, not attempted blind)

| Ticket | Title | Track | Priority | Notes |
|--------|-------|-------|----------|-------|
| T15 | `properties-panel.ts`'s `render()` does a full `innerHTML = ''` teardown/rebuild on every store change (not just on selection change) — same code-smell class as T11's root cause (full DOM teardown on every update, there it reset scroll position; here the blast radius is unconfirmed) | human | P2 | Most property inputs (dimensions, name, texture/material selects) use the `change` event (fires once on blur/Enter), so are not affected the same way T11 was. The two color-picker inputs (`leftColor`/`rightColor` on walls, `floorColor`/`colorIn` on rooms/furniture, lines ~349/354/518/617) use the `input` event, which fires continuously while dragging the native color picker — meaning a color-drag likely triggers many consecutive full-panel teardown/rebuilds per drag. Not live-reproduced this round (would need to actually drag a color swatch and watch for visible jank/focus loss), so left as backlog rather than fixed blind, per this round's explicit instruction not to guess at ambiguous findings. |
| ~~T8~~ | ~~Batch/transactional furniture operations for agents~~ | agent | — | **Closed by T14 above** — confirmed the only real gap was `select_object` not accepting an arbitrary subset; `modify_selected`/`delete_selection` already handled batch operation over whatever `home.selection` contains. No separate `move_furniture_batch`/`delete_many` tools needed. |

T6 and T7 (live wall-dimension readout; lighting/materials realism pass)
remain untouched from the prior backlog — not revisited this round, no new
information gathered on either.

### Operational note — concurrent dev servers can silently break the pre-push e2e gate

`vite.config.ts` hardcodes `port: 1420` as the dev server default, and
`playwright.config.ts`'s own `webServer` defaults to the **same** port
1420 with `--strictPort`. If another session/worker already has a
`npm run dev` running on 1420 (e.g. for live MCP testing, as in this
audit), `git push origin main`'s pre-push hook will have Playwright attach
to that **other, stateful** session's page instead of a fresh fixture,
producing spurious `Test timeout ... waiting for locator(...)` failures
that look like real UI regressions but are actually port contention, not
a code defect. Confirmed via a live incident this round (T14's push
initially failed with 5 e2e failures from `level-deletion.spec.ts`/
`toolbar-level-discoverability.spec.ts`, ruled out as a regression by
confirming the DOM/code was untouched, then reproduced consistently
exactly while the other dev server stayed up). Workaround that does not
require killing another session's legitimate work:
`E2E_PORT=<free-port> git push origin main` — Playwright's `webServer`
will spin up its own isolated dev server on that port instead of
colliding with 1420.

### Verification notes — this Audit round

- T14: `cd app && npm run check && npx vitest run && npm run lint && cd mcp && python3 -m pytest -q` — all re-run and confirmed green by the manager directly (not just worker self-report). `E2E_PORT=14205 git push origin main` used to route around a concurrent dev-server session on port 1420 (see operational note above); full local e2e gate (105/105) passed under the alternate port. CI run https://github.com/BuildMy-house/app/actions/runs/37455358575 and deploy run https://github.com/BuildMy-house/app/actions/runs/37455739025 both watched to green via `gh run watch`/`gh run view`.
