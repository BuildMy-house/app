# House Designer — Improvement Tickets (Wave Dispatch)

**Date:** 2026-09-14  
**Start Time:** 09:27 UTC  
**Manager:** claude-haiku-4-5-20251001  
**Coordination:** CLI-only dispatch + git commits + Steward ACS (auto-integrated via opencode)  
**Cost Tracking:** .claude/opencode-costs.md

---

## Dispatch Status (Updated 09:30 UTC)

**All 5 tickets DISPATCHED and running in parallel.** Steward ACS coordination active.

### Wave 1: Short mechanical tasks (ACTIVE)

| Ticket | Scope | Session ID | PID | Status | Branch |
|--------|-------|-----------|-----|--------|--------|
| **T2** | 3D level filtering | ses_f60bdb864ffe0UvnvOIKCkQ0oK | 153923 | RUNNING | feat/t2-level-filtering |
| **T3** | Catalog panel width | ses_f60c08e75ffer9EgQLpuB3au60 | 153765 | RUNNING | feat/t3-catalog-width |

**Expected:** T2, T3 complete within 2-4 hours (1 day + 2 hours estimate)

### Wave 2: Longer features (ACTIVE)

| Ticket | Scope | Session ID | PID | Status | Branch |
|--------|-------|-----------|-----|--------|--------|
| **T1** | Wall-opening cutouts | ses_f60bd846fffeLGdEuUT1FQz2CM | 154471 | RUNNING | feat/t1-wall-cutouts |
| **T5** | CI/CD setup | (initializing) | 154470 | RUNNING | feat/t5-ci-cd |

**Expected:** T1, T5 complete within 3-7 days (2-4 days + 3-5 days estimate)

### Wave 3: Small task (ACTIVE)

| Ticket | Scope | Session ID | PID | Status | Branch |
|--------|-------|-----------|-----|--------|--------|
| **T4** | Polyline face fill | (initializing) | 153924 | RUNNING | feat/t4-polyline-fill |

**Expected:** T4 complete within 4-8 hours (4 hours estimate)

---

## Detailed Tickets

### [T2] 3D level filtering/scoping (P1, 1 day)
- **Scope:** Filter 3D view rendering by active level (plan-view already scopes, 3D needs same)
- **Files:** buildmyhouse/src/view3d/scene.ts, buildmyhouse/src/view3d/scene-builder.ts
- **DoD:** Switch levels in UI, 3D view updates to show only active level objects
- **Model:** opencode/mimo-v2.5-free (free tier, mechanical)
- **Session:** ses_f60bdb864ffe0UvnvOIKCkQ0oK
- **PID:** 153923

### [T3] Widen catalog panel (P2, 2 hours)
- **Scope:** Change catalog panel from fixed 240px to responsive width showing full names
- **Files:** buildmyhouse/src/main.ts, buildmyhouse/src/style.css
- **DoD:** All furniture names visible without truncation
- **Model:** opencode/mimo-v2.5-free (free tier, mechanical)
- **Session:** ses_f60c08e75ffer9EgQLpuB3au60
- **PID:** 153765

### [T1] Wall-opening cutouts for doors/windows (P1, 2-4 days)
- **Scope:** Implement geometric wall-opening subtraction when doors/windows placed on walls
- **Files:** buildmyhouse/src/view3d/scene-builder.ts, buildmyhouse/src/core/model.ts
- **DoD:** E2E test places door on wall, 3D shows visible opening in wall mesh
- **Model:** opencode/mimo-v2.5-free initially (free tier); escalate to glm-5.3 if needed
- **Session:** ses_f60bd846fffeLGdEuUT1FQz2CM
- **PID:** 154471

### [T5] CI/CD setup (P3, 3-5 days)
- **Scope:** GitHub Actions: automated test + build on every push (lint, type, unit, E2E, coverage)
- **Files:** .github/workflows/test-and-build.yml (create), package.json (update if needed)
- **DoD:** All checks run on PR to main; status required before merge
- **Model:** opencode/mimo-v2.5-free initially; escalate if needed
- **Session:** (initializing)
- **PID:** 154470

### [T4] Polyline face fill (P2, 4 hours)
- **Scope:** Add filled face to closed polylines (currently outline-only)
- **Files:** buildmyhouse/src/plan/renderer.ts, buildmyhouse/src/core/model.ts
- **DoD:** Draw closed polyline, verify interior fill + outline visible
- **Model:** opencode/mimo-v2.5-free (free tier, mechanical)
- **Session:** (initializing)
- **PID:** 153924

---

## Monitoring Instructions

### Live Status Checks
```bash
# Check which opencode processes are still running
pgrep -f "opencode run" | wc -l

# Check last lines of each dispatch log (real-time progress)
for t in t1 t2 t3 t4 t5; do 
  echo "=== $t ===" 
  tail -3 /tmp/${t}-dispatch.log 2>/dev/null | head -1
done

# Monitor full opencode.log for quota warnings
tail -20 ~/.local/share/opencode/log/opencode.log | grep -E "Weekly|Rate limit|error"
```

### Stall Detection (10-minute threshold)
If a dispatch shows ZERO progress (no new log lines) for 10+ minutes:
1. Check `opencode.log` for quota wall: `grep "Weekly usage limit\|Rate limit" ~/.local/share/opencode/log/opencode.log`
2. If quota-limited: note in PLAN.md, no action (wait for reset or redispatch to different provider)
3. If no quota issue: kill process and redispatch to same session with `--session <id>`

### Session Continuation (if needed)
```bash
# Resume T1 after a stall (example)
opencode run -m opencode/mimo-v2.5-free --session ses_f60bd846fffeLGdEuUT1FQz2CM --auto --format json < /tmp/t1-prompt.txt
```

---

## Cost Tracking

All dispatches use **free tier (opencode/mimo-v2.5-free)** for cost optimization.

Escalation to `opencode-go/glm-5.3` only if:
1. Free tier output is incomplete/incorrect after revision
2. Complex geometric/architectural logic in T1 demands stronger model
3. CI/CD configuration in T5 hits edge cases free tier can't handle

Cost log: `.claude/opencode-costs.md` (update as dispatches complete)

---

## Coordination Notes

- **Steward ACS:** Integrated automatically via opencode CLI (agents register, lock files, save learnings)
- **Git discipline:** Each ticket MUST commit real work before marking done—no uncommitted diffs in shared checkout
- **Concurrent sessions:** ~14 opencode processes active (normal per CLAUDE.md)
- **Session IDs:** Use for resuming interrupted dispatches via `opencode run --session <id>`

---

## Expected Timeline

| Phase | Tickets | Est. Duration | Start | Target Complete |
|-------|---------|---|-------|---|
| Wave 1 (verification) | T2, T3 | 2-4h | 09:30 UTC | 14:00 UTC |
| Wave 2 (parallel) | T1, T5 | 3-7d | After Wave 1 verification | Sept 21 |
| Wave 3 (parallel) | T4 | 4-8h | Anytime | Sept 15 |

---

## Commit Messages (Reference)

```
# T1 (when ready)
feat(3d): wall-opening cutouts — subtract doors/windows from wall mesh

Implements geometric cutout subtraction when doors/windows are placed on walls.
3D viewport now shows holes in walls for placed openings.

# T2 (when ready)
feat(3d): level filtering — hide inactive level objects in 3D viewport

Applied activeLevel filter to Scene and scene-builder, mirroring plan-view
scoping behavior. 3D viewport now hides objects not on the current level.

# T3 (when ready)
feat(ui): widen catalog panel — display full furniture names

Changed catalog panel from fixed 240px to responsive width, eliminating
truncation of furniture names. Panel now adapts to content while remaining
balanced in the UI layout.

# T4 (when ready)
feat(plan): polyline face fill — render interior fill for closed shapes

Added filled face rendering for closed polylines (currently outline-only).
Draw a closed shape in plan view; interior fill + outline both visible.

# T5 (when ready)
ci: add GitHub Actions workflow for lint, test, build

Automated CI/CD on every push: lint, type-check, unit tests, E2E tests,
coverage reporting. Status required for merge to main.
```

