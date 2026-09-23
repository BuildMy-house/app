# Reference house study

Three MCP-sourced house references were rebuilt in BuildMyHouse using the
connected `buildmyhouse_local` MCP server, then re-rendered locally through
the app's real Three.js viewport. The goal was visual approximation, not
architectural measurement.

> **Status note (2026-09-21):** this writeup was recovered from an agent
> report pasted into a session; the input/render images and the
> `scripts/build-reference-study.ts` script it describes were **not found
> anywhere in this workspace** (checked `app`, `app-rooms-feature`, and
> every other subrepo — no matching files, branches, or commits). Treat the
> comparison table and issue list below as a specification of prior intent
> to reproduce, not as verified-current output. See the "Fix plan" section
> for how this gets re-verified.

## Input vs final render

<table>
<tr><th>Reference input</th><th>BuildMyHouse final render</th></tr>
<tr><td><img src="input/01-eichler.jpg" width="480" alt="Eichler-inspired reference"></td><td><img src="renders/01-eichler.png" width="480" alt="Eichler-inspired BuildMyHouse render"></td></tr>
<tr><td><img src="input/02-alpine.jpg" width="480" alt="Alpine prefab reference"></td><td><img src="renders/02-alpine.png" width="480" alt="Alpine prefab BuildMyHouse render"></td></tr>
<tr><td><img src="input/03-snow-cabin.jpg" width="480" alt="Snow cabin reference"></td><td><img src="renders/03-snow-cabin.png" width="480" alt="Snow cabin BuildMyHouse render"></td></tr>
</table>

## What was built

| Study | MCP-built plan | Final render approximation |
| --- | --- | --- |
| Eichler-inspired | 1,200 × 700 cm shell, divider wall, living/dining room, bedroom, sofa, coffee table, dining table, bed | Open indoor/outdoor plan with warm timber walls and blue glazing placeholders |
| Alpine prefab | 850 × 650 cm open plan, table, armchair, fireplace, plant | Dark-clad single-volume retreat with warm floor and furniture grouping |
| Snow cabin | 900 × 560 cm shell, living room, bedroom, sofa, coffee table, bed, desk | Compact timber cabin with split rooms and cool glazing placeholders |

## Issues and missing features

### Issues encountered

1. The MCP advertised `build_house`, `frame_scene`, and roof operations, but
   the connected app's automation handler at the time returned
   `UNKNOWN_COMMAND` for those commands. Construction therefore used the
   working MCP sequence of `reset_home`, `draw_rectangular_room`, `click`,
   `add_room`, `add_furniture`, `scene_summary`, `validate_scene`, and
   `screenshot`.
   **Re-verified 2026-09-21 against `src/automation/homely-handler.ts` and
   `mcp/server.py`:** `frame_scene` (handler line 279) and `add_roof`
   (handler line 426) are implemented in the handler's command switch, and
   the Python orchestrator (`mcp/automation_server.py`'s `Session.request`)
   forwards every command name verbatim with no intermediate allowlist that
   could silently drop one — so there is no separate routing bug to find
   between the MCP tool layer and the handler. `build_house` (`mcp/server.py`
   lines 422-580) is correctly implemented too, but not as a handler-side
   `case 'build_house':` — it is an MCP-server-side orchestration function
   that decomposes one declarative plan into the existing granular commands
   (`add_level`, `add_wall`, `add_room`, `add_door`/`add_window`,
   `add_furniture`/`catalog_add_furniture`, `add_roof`, `add_polyline`,
   `add_label`, `add_dimension_line`, `set_camera`, `get_state`), all of
   which the handler already supports. This is covered by
   `mcp/test_build_house.py`'s `FakeSession`-based unit test. Regression
   tests for `frame_scene`/`add_roof` succeeding end-to-end through the real
   `HomelyCommandHandler` (not just a fake) were added to
   `tests/handshake.test.ts` on 2026-09-21. Net result: none of `build_house`,
   `frame_scene`, or `add_roof` are missing or broken today — the earlier
   `UNKNOWN_COMMAND` reports predate `frame_scene`/`add_roof` landing in the
   handler switch, and `build_house` was never meant to be a handler-side
   command in the first place. The connected `documents/plans/mcp-scene-builder`
   spec's characterization of `build_house` as "the primary declarative
   construction entry point" is accurate; it was this doc's original
   "still absent from the switch" framing that was the mismatch, since it
   assumed `build_house` had to appear as its own switch case to be
   "implemented" — flagged and corrected here rather than adding a
   redundant/wrong handler case.
2. The MCP screenshot tool returned image content for visual verification,
   but this session could not persist those MCP image blocks directly to
   project files. The local Playwright pass produced the checked-in PNG
   comparison renders.
3. ~~The default 3D camera plus a solid roof hides the interior. The
   comparison captures omit the roof so the interiors remain visible; this
   is explicitly a presentation workaround, not a faithful roof
   reconstruction.~~ **Closed 2026-09-21:** roof visibility in the live
   viewport is now fully automatic, tied to the outside/inside view mode
   rather than a user-facing control: the roof render loop in
   `src/view3d/scene.ts` gates on `isOutsideView` (added in commit 4d6bffc),
   so roofs hide themselves whenever the viewport is not in outside/exterior
   view — there is no "Roof" toolbar toggle anymore. `View3D.setRoofVisible()`
   / `View3D.showRoof` and the headless `CaptureService`
   (`setRoofVisible`/`getRoofVisible`), exposed as the `set_roof_visible`
   automation command (`src/automation/homely-handler.ts`) and MCP tool
   (`mcp/server.py`), still exist and still work exactly as before, but only
   as a dev/automation override for scripted screenshots — not as something
   surfaced in the app's own toolbar — so scripted comparison renders can
   still hide the roof for an interior shot without omitting it from the home
   state itself, closing the presentation-workaround gap this issue
   described. Covered by tests in `src/view3d/scene.test.ts`,
   `tests/capture.test.ts`, and `tests/handshake.test.ts`.
4. Furniture catalog items are mostly proxy geometry and vary from the
   reference furniture in scale, color, and silhouette.
5. The first MCP study reported two unconnected divider-wall endpoints; the
   scene remained `valid: true`, but the warning is retained as a
   fidelity/cleanup issue.

### Missing features needed for closer matches

- ~~Reliable MCP `build_house` orchestration in the connected app.~~ Done —
  confirmed working as a plan-decomposition function in `mcp/server.py`,
  unit-tested in `mcp/test_build_house.py`.
- ~~MCP roof creation and scene framing wired through the current automation
  protocol.~~ Done — `add_roof`/`frame_scene` handler support exists and is
  now covered by end-to-end regression tests in `tests/handshake.test.ts`
  that exercise the real production `HomelyCommandHandler` (not a fake).
- ~~A roof cutaway / hide-roof / section-camera mode for interior renders.~~
  Done — see issue #3 above (`showRoof` option on `buildScene`/`View3D`,
  toolbar toggle, `set_roof_visible` automation command and MCP tool).
- ~~Exterior site context~~: trees, snow, decks, patios, landscape, terrain,
  and background photography. **Closed 2026-09-21 (Ticket 5d), partially;**
  then tree/deck placeholders and site-context toggle removed entirely
  (2026-09-22) because they only rendered in the WebGL editor view and not
  in the photoreal LuxCore render pipeline, which was confusing. The ground
  variation (per-vertex color hash via `applyGroundVariation()`) was kept.
  **Still open:** patios, full landscape/terrain modeling, and background
  photography were judged a larger lift than "keep it modest" allows and
  remain backlog items.
- ~~Real glass, reflective materials~~ for windows. **Closed 2026-09-21
  (Ticket 5a):** window furniture (`Furniture.doorOrWindow === true` and a
  `/window/i` name match — the same convention `add_door`/`add_window` in
  `src/automation/homely-handler.ts` already uses to tell doors from
  windows, since there is no separate structural discriminator field) now
  gets a `THREE.MeshPhysicalMaterial` with `transmission`/`ior`/`thickness`
  in `furnitureMesh()` (`src/view3d/scene.ts`, `isWindowFurniture()` /
  `windowGlassMaterial()`) instead of the flat blue-box placeholder. Windows
  are also excluded from `addFurnitureMeshes()`'s instancing path so each
  one keeps its own glass material rather than being batched into a shared
  opaque `InstancedMesh`. Covered by tests in `src/view3d/scene.test.ts`
  (`describe('window glass material (Ticket 5a)')`). **Closed 2026-09-21
  (Ticket 5b):** furniture fabric materials and general lighting controls
  also landed — non-window box furniture (including instanced groups) now
  gets a `MeshPhysicalMaterial` with a sheen lobe (`fabricMaterial()` in
  `src/view3d/scene.ts`) for a matte, upholstered look instead of the old
  flat hard-surface material, and a `lightIntensity` multiplier (default 1)
  scales every scene light for exposure adjustment — wired to a "Light"
  slider in the toolbar (`src/main.ts`), `View3D.setLightIntensity()` for
  the live viewport, and `CaptureService.setLightIntensity()` /
  `set_light_intensity` automation command and MCP tool for scripted
  renders. Covered by tests in `src/view3d/scene.test.ts`,
  `tests/capture.test.ts`, and `tests/handshake.test.ts`. **Closed
  2026-09-21 (Ticket 5c):** exterior cladding material fidelity for walls
  also landed — `wallMesh()` (`src/view3d/scene.ts`) now builds its material
  via `claddingMaterial()`, a `THREE.MeshPhysicalMaterial` with a subtle
  clearcoat lobe (weather-sealed paint/siding sheen) layered on top of the
  same color/roughness/metalness inputs the old flat `MeshStandardMaterial`
  used, instead of a completely flat diffuse surface. The existing
  `leftSideTextureId`/PBR-map pipeline (`applyMaterialTextures()`) keeps
  working unmodified, since `MeshPhysicalMaterial` is a strict superset of
  the `MeshStandardMaterial` properties it sets. Note: there is no
  interior/exterior wall discriminator in the data model (walls have no
  room-adjacency reference and rooms have no wall reference — they are
  independent geometry, SweetHome3D-style), so this applies the cladding
  material to every wall uniformly rather than only exterior-facing ones;
  real per-wall exterior detection would need a room/wall adjacency
  computation the schema doesn't support today and was judged out of scope
  for this ticket's "keep it modest" instruction. Covered by tests in
  `src/view3d/scene.test.ts` (`describe('exterior cladding material (Ticket
  5c)')`).
- Image-based reference overlay or camera matching for tracing proportions
  from a photo.
- More architectural elements: large sliding-glass assemblies, skylights,
  stairs, chimneys, and multi-level massing. **Ticket 5e — deferred
  2026-09-21:** explicitly not attempted this wave per the original
  instruction to only pick it up "if time remains" after 5a-5d; each of
  these (skylights, sliding-glass, stairs, chimneys, multi-level massing)
  is closer in scope to a new geometry/data-model feature than a materials
  tweak, so it's left as a future-wave ticket rather than rushed.

## Source references

- [Westfall Case Study / Open Homes Photography](https://www.open-homes.com/portfolio/the-art-of-the-eichler/) — image downloaded from `https://www.open-homes.com/app/media/westfall-case-study-hero.jpg`.
- [Building a Prefab in Arizona / Den Outdoors](https://denoutdoors.com/pages/building-a-prefab-in-arizona) — image downloaded from `https://cdn.shopify.com/s/files/1/0280/5429/0496/files/den-modern-alpine-2025-5773682.jpg?v=1755122332`.
- [Modern house with wooden deck in snowy landscape / Unsplash](https://unsplash.com/photos/modern-house-with-wooden-deck-in-snowy-landscape-Wd8Nm8iXglQ) — image downloaded from the Unsplash image URL returned by MCP image search.

## Reproduction

Not currently reproducible as written — `scripts/build-reference-study.ts`
does not exist in this repo. Re-creating it is tracked in the fix plan
below (see the Steward plan doc
`documents/plans/reference-house-study-fixes` under `buildmy-house-app`).

```sh
cd buildmyhouse
npm run dev -- --port 1430 --strictPort
BASE_URL=http://localhost:1430 node --import tsx scripts/build-reference-study.ts
```

The MCP connection helper referenced above is `scripts/connect-mcp.ts`; it
opens the app with `?automationPort=9529` so the connected MCP server can
mutate and verify the live home. Confirm this script also exists before
relying on it — it was not found in this workspace either.
