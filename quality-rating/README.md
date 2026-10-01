# 3D View Quality Rating Pipeline

On-demand quality rating for the 3D viewport. Never runs automatically — no CI
wiring, no pre-commit hooks. A human or agent deliberately runs:

```sh
npm run quality:rate                        # full run: 3 scenes × 4 tiers × 2 cameras = 24 records
npm run quality:rate -- --grep "furnished"  # narrow: one scene
npm run quality:rate -- --grep "ultra"      # narrow: one tier
```

## What a run does

1. Starts the real dev server (reuses `playwright.config.ts` webServer/GPU
   pinning via `playwright.quality.config.ts`) and drives **real WebGL
   Chromium** — NOT the flat buildmyhouse-MCP rasterizer, which cannot see
   bloom/shadows/AO/LOD.
2. For each scene × quality tier, builds the scene, switches to the 3D view,
   fits, then per camera preset (observer, top): samples 30 RAF frame times,
   collects the app's own `ViewportQualitySnapshot` (via the private
   `collectViewportQualitySnapshot()` on `window.__view3d` — same escape hatch
   the e2e specs use), and screenshots `#view3d`.
3. Grades each capture with pure heuristics (`heuristics.ts`, unit-tested in
   `heuristics.test.ts` under `npm run test`).
4. Optional vision tier: every fail/borderline + ~10% random sample of passes
   is sent to `claude-haiku-4-5` for a defect look-over (`vision-judge.ts`).
   Set `ANTHROPIC_API_KEY` to enable; without it the tier prints one warning
   line and skips — never a hard failure.
5. Writes per-record JSON + screenshots to `quality-rating/reports/<run-id>/`,
   then `summary.json` there and a copy to `quality-rating/reports/latest.json`.
   `reports/` is gitignored.

## Heuristic thresholds

Score = 100 − 40 × hard − 15 × soft (floor 0). Any hard → `fail`, any soft →
`borderline`, else `pass`.

- **Hard:** >20% of sampled frames spike (> 2× median, needs ≥ 6 samples);
  `triangleCount === 0` with objects present; geometry in an empty scene.
- **Soft:** any smaller spike presence; avg > 150k triangles/object;
  `drawCalls > 4 × (furniture + walls + rooms) + 100`; LOD culling expected
  but draw calls still > 4 × furniture + 100.

Note: the shipped preset fields are `lodCullScreenFraction` /
`transparentLodCullScreenFraction` (screen-fraction, DPI-independent — see
`src/view3d/viewport-quality.ts`, landed alongside this pipeline). The grade
context's `expectedLodCullScreenFraction` is still only a per-scene boolean
"culling expected here" signal, not a numeric comparison against the preset's
own fraction value — it marks scenes furnished enough that LOD culling should
visibly reduce draw calls.

## Scene building notes

App quirks the spec works around (re-check these if captures regress):

- **Walls are built via the store API** (`window.__model.addWall`, closed
  400×400cm square), not the wall tool: tool clicks snap to grid/endpoints and
  the plan view re-zooms as walls land, producing crossed nondeterministic
  geometry. App world units are centimeters.
- **Glass/doors are mounted via the store API** (`doorOrWindow: true` +
  `wallRef` + `wallOffset`), matching `e2e/door-window-wall-cutouts.spec.ts`.
- **Never clear the catalog search box** between placements: setting it to
  `''` re-renders the virtualized grid and the store loses just-placed
  furniture (observed count reset 1→0). `fill(name)` replaces the value
  wholesale, so no clear is needed.
- Catalog placement is gated on UI state (`Placing:` → disarm message) plus a
  store furniture-count poll — a click landing before arming is silently
  swallowed otherwise.

## Closing the loop (AGENT action, not automated)

This pipeline does not file tickets itself. After a run, the driving agent
should:

1. Read `quality-rating/reports/latest.json`.
2. For every record with `heuristic.verdict === "fail"` (and investigate
   `borderline` when a scene degrades across tiers), create a Steward work
   item describing the failing reasons + screenshot path.
3. After each fix lands, re-run narrowly:
   `npm run quality:rate -- --grep "<scene>"` and confirm the record passes.
4. Update the Steward planning doc
   `buildmy-house-app/documents/plans/realtime-3d-view-quality-pipeline` with
   the run outcome (the pipeline itself has no Steward MCP access).
