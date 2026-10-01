---
name: quality-rate
description: Run the 3D-viewport quality-rating pipeline (npm run quality:rate), read quality-rating/reports/latest.json, and close the loop — file Steward work items for every heuristic fail, re-run narrowly after a fix, and update the Steward planning doc. Use whenever asked for a "quality rate" pass, a viewport perf/visual check, or to triage quality-rating reports in this repo.
---

# 3D view quality-rate pass

On-demand quality rating of the live Three.js viewport. The pipeline drives
real WebGL Chromium against the dev server (via `playwright.quality.config.ts`),
grades each capture with pure heuristics, optionally sends fail/borderline
captures to a vision judge, and writes JSON + screenshots under
`quality-rating/reports/`. It **never** runs in CI or pre-commit — you run it
deliberately and then close the loop yourself.

## When to use

1. On-demand quality check of the live Three.js viewport — user or ticket asks
   for a quality/perf pass, or after a rendering change you want a before/after.
2. Never wire this into CI/pre-commit; it is a manual, agent-driven command only.

## Prerequisites

1. Dev server available through `playwright.quality.config.ts` (the run starts
   it itself, reusing the main playwright webServer/GPU pinning — don't start
   one manually first; if a stale server holds the port see Failure recovery).
2. `claude` CLI authenticated on this machine — the optional vision-judge tier
   shells out to it (`quality-rating/vision-judge.ts`). Treat it as a
   best-effort dependency; the run still succeeds without it.
3. Steward ACS access (create_work / claim_work / lock_file / specs_propose)
   so you can file tickets and update the planning doc.

## Commands

From `app/`:

```sh
npm run quality:rate                        # full run: 24 records (3 scenes × 4 tiers × 2 cameras)
npm run quality:rate -- --grep "<pattern>"  # narrow run: only matching test titles
```

Exact names you can grep on (from the spec):

- Scenes: `empty-room`, `furnished-living-room`, `glass-window-scene`
- Tiers: `low`, `medium`, `high`, `ultra`
- Cameras (per scene/tier): `observer`, `top`

Examples:

```sh
npm run quality:rate -- --grep "furnished"   # one scene
npm run quality:rate -- --grep "ultra"       # one tier
npm run quality:rate -- --grep "glass-window-scene · ultra"  # one scene+tier
```

## Read the results

1. Read `quality-rating/reports/latest.json` (the run also writes
   `quality-rating/reports/<run-id>/summary.json` plus per-capture PNGs;
   `reports/` is gitignored).
2. Each record carries: `scene`, `tier`, `camera`,
   `screenshot` (path like `quality-rating/reports/<run-id>/<scene>-<tier>-<camera>.png`),
   `heuristic.verdict` (`"pass" | "borderline" | "fail"`),
   `heuristic.reasons` (string[]), `heuristic.score` (0–100),
   and — for the judged subset only — `visionVerdict` / `visionNotes`.
3. Quick triage with jq:
   ```sh
   jq -r '.[] | select(.heuristic.verdict != "pass") | "\(.heuristic.verdict) \(.scene)/\(.tier)/\(.camera): \(.heuristic.reasons | join("; "))"' quality-rating/reports/latest.json
   ```

## Close the loop (AGENT action, not automated)

The pipeline files nothing itself. After every run:

1. **File a Steward work item for every fail.** For each record with
   `heuristic.verdict === "fail"`:
   - `create_work(title="<scene>/<tier>/<camera> quality fail: <first reason>", claim=true, agent_id="<you>")`, then
     `claim_work(task_id, agent_id="<you>")` if not already claimed.
   - In the work item body include: the record's `heuristic.reasons` verbatim
     (all of them), the `heuristic.score`, the tier/camera, and the exact
     screenshot path from the record's `screenshot` field (e.g.
     `quality-rating/reports/<run-id>/glass-window-scene-ultra-top.png`) so the
     fixer can look at the capture.
   - `lock_file` only the files you actually edit for the fix.
2. **Investigate borderline records** — especially a scene that is `pass` at
   `low`/`medium` but `borderline` (or worse) at `high`/`ultra`, i.e. degrades
   across tiers. Same treatment: work item with the reasons + screenshot path.
3. **After a fix lands, re-run narrowly and confirm:**
   ```sh
   npm run quality:rate -- --grep "<scene>"   # or "<scene> · <tier>"
   ```
   Re-read `quality-rating/reports/latest.json` and confirm that record's
   `heuristic.verdict` is now `"pass"`; only then close the work item
   (`close_work(task_id, learned_for_agents="...", improvements="...")`).
4. **Update the Steward planning doc** with the run outcome (what ran, pass/
   fail/borderline counts, tickets filed, what was confirmed fixed):
   `specs_propose` against document
   `buildmy-house-app/documents/plans/realtime-3d-view-quality-pipeline`.

## Verification

The skill worked if, after the command returns:

1. Console output contains
   `[quality-rating] wrote N records to .../summary.json`
   (`N` = 24 for a full run, fewer for a `--grep` run).
2. `quality-rating/reports/latest.json` and
   `quality-rating/reports/<run-id>/summary.json` both exist and their mtime
   is newer than the run's start time:
   ```sh
   stat -c '%y %n' quality-rating/reports/latest.json
   ```
3. `jq length quality-rating/reports/latest.json` matches the `N` above.
4. Every non-pass record has a corresponding Steward work item and the
   planning doc was updated (steps 1–4 of Close the loop).

## Failure recovery

1. **Dev server fails to start / port conflict** (vite can't bind, playwright
   webServer timeout): do not force it, do not kill unknown processes. Note the
   exact error in the Steward work item (or create a short one) and stop — the
   run can be retried once the port is free.
2. **Vision-judge tier warning** (`claude` CLI missing from PATH or not
   authenticated, a `[quality-rating] vision judge failed: ...` line, or
   `vision judge produced unparseable output`): this is best-effort by
   design — the tier shells out to the local `claude --print` CLI (no API
   key), and any failure there degrades to one warning line. The run still
   succeeded on its heuristic tier — proceed with the loop using
   `heuristic.verdict` / `heuristic.reasons`; a missing `visionVerdict` is
   not a skill failure.
3. **Partial run / crash mid-way**: treat `latest.json` as stale unless its
   mtime is from this run; re-run rather than triaging old records.
