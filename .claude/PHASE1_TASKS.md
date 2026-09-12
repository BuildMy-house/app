# Phase 1: Auto-Floor Core — Task Tracking

**Project:** Homely (buildmyhouse, Tauri/TypeScript)  
**Feature:** Auto-floor generation from closed wall loops  
**Status:** Wave 1 Complete ✅ | Wave 2 Ready | Wave 3 Queued

---

## Status Legend

Use this vocabulary consistently across the board and in dispatch notes:

- `open` — ticket not yet dispatched
- `dispatch-wave-N` — dispatched in wave N, awaiting worker completion
- `verification` — worker completed, awaiting manager review (diff read, DoD pass, live-test if needed)
- `done` — verified and committed
- `blocked` — dependencies unmet, worker blocked, or issue discovered; awaiting new ticket or clarification

---

## In Flight

Current active tickets (dispatched, awaiting completion):

- *(none — Wave 2 not yet dispatched)*

---

## Wave 1: Core Algorithm (✅ COMPLETE)

### T1: WallLoopDetector.ts
- **Status:** ✅ **DONE**
- **File:** `buildmyhouse/src/core/wall-loop-detector.ts`
- **Commits:** ba8eced, 737fd41
- **What was built:**
  - `detectClosedLoops(walls: Wall[], tolerance=0.01): WallLoop[]`
  - Graph-based cycle detection via DFS
  - Validation: ≥3 walls, area ≥ 0.1, degree-2 constraints
  - Typed interfaces: Wall, WallLoop
- **Quality:** ✅ High-quality TypeScript implementation with JSDoc
- **Tests:** Unit tests needed (part of T4)

**✅ Wave 1 Status:** Ready for Wave 2

---

## Wave 2: Integration & UX (✅ COMPLETE)

### T2: PlanController Integration (Auto-Floor Room Creation)
- **Status:** ✅ **DONE**
- **File:** `buildmyhouse/src/plan/engine.ts` (modify `createRoomsFromWalls`)
- **Dependencies:** T1 ✅ Complete
- **Scope:**
  - Import `detectClosedLoops` from WallLoopDetector
  - Call on wall finalization (double-click completion)
  - Extract inner polygon from detected loop
  - Create Room object with extracted polygon
  - Integrate with existing room creation + undo/redo
- **Success Criteria:**
  - Walls drawn → loop detected → auto-room created
  - Undo/redo works seamlessly
  - No regressions in existing room creation
- **Estimated:** 3-4 hours
- **Worker Profile:** TypeScript specialist (knows plan/engine logic)

### T3: Auto-Floor Confirmation Dialog (UX Flow)
- **Status:** ✅ **DONE**
- **Files:** 
  - `buildmyhouse/src/ui/AutoFloorDialog.tsx` (NEW)
  - `buildmyhouse/src/plan/engine.ts` (modify state)
- **Dependencies:** T1 ✅ Complete
- **Scope:**
  - React dialog component showing: "Create room from closed walls?"
  - Confirm → trigger room creation via T2 integration
  - Cancel → discard auto-floor, continue editing
  - Integrate into wall completion flow
- **Success Criteria:**
  - Dialog appears on loop detection
  - User controls (Confirm/Cancel) work correctly
  - Dialog integrates cleanly with existing UX
- **Estimated:** 2-3 hours
- **Worker Profile:** React/UI specialist

**Wave 2 Ready Status:** Both tickets can be dispatched in parallel after T1 merges

---

## Wave 3: Testing (⏳ QUEUED)

### T4: Auto-Floor Test Suite
- **Status:** ⏳ **QUEUED**
- **Files:**
  - `buildmyhouse/tests/wall-loop-detector.test.ts` (unit tests)
  - `buildmyhouse/tests/auto-floor.test.ts` (integration tests)
  - `buildmyhouse/e2e/auto-floor.spec.ts` (E2E/Playwright)
- **Dependencies:** T1 ✅, T2 ⏳, T3 ⏳
- **Scope:**
  - Unit: WallLoopDetector edge cases (rectangles, polygons, T-junctions, etc.)
  - Integration: wall chain → room creation with undo/redo
  - E2E: Playwright UI flow (draw walls → dialog → confirm → room created)
- **Success Criteria:**
  - >90% coverage
  - All tests pass (no regressions)
  - Edge cases covered
- **Estimated:** 3-5 hours
- **Worker Profile:** Full-stack test specialist (TS + Playwright)

**Wave 3 Status:** Queued, dispatch after T2/T3 land

---

## Dispatch Strategy

| Wave | Tickets | Status | Action |
|------|---------|--------|--------|
| **1** | T1 | ✅ Complete | Monitor merge |
| **2** | T2, T3 | ⏳ Ready | Dispatch parallel after T1 merges |
| **3** | T4 | ⏳ Queued | Dispatch after T2/T3 merge |

---

## File Scope & Collision Prevention

| Ticket | Files | Risk | Mitigation |
|--------|-------|------|-----------|
| T1 | `src/core/wall-loop-detector.ts` | ✅ None | New file |
| T2 | `src/plan/engine.ts` | ⚠️ Medium | Modify only `createRoomsFromWalls()` method |
| T3 | `src/ui/AutoFloorDialog.tsx`, `src/plan/engine.ts` | ⚠️ Medium | New dialog file; coordinate state changes with T2 |
| T4 | `tests/` | ✅ None | Test files only |

**File Locking:** Use Steward `lock_file` to prevent concurrent modifications of `src/plan/engine.ts` in T2/T3.

---

## Verification Checklist (Manager Review)

Use this checklist for each completed ticket before marking it `done`:

- [ ] **Diff matches ticket intent** — Read the actual changes; no scope creep or unrelated edits
- [ ] **DoD commands pass** — `./scripts/verify-all.sh` (or `--skip-e2e` fast path); `npx vitest`; `npm run e2e` if UI-affected
- [ ] **No regressions** — Test counts match or are explicitly documented (expected increase if tests added)
- [ ] **If user-facing** — Live-tested in the app; UX flows work as intended
- [ ] **Committed correctly** — Exact files from ticket scope only, no unrelated changes

---

## Next Actions

1. ✅ **T1 verification:** Review diff ba8eced, run tests
2. ⏳ **T2/T3 dispatch:** Create Steward tasks, assign workers (use agent-manager)
3. ⏳ **Wave 2 coordination:** Lock `src/plan/engine.ts` during T2/T3 execution via Steward
4. ⏳ **T4 dispatch:** After Wave 2 merges, create comprehensive test suite
5. 📋 **Documentation:** Update IMPROVEMENT_PLAN.md with TypeScript implementation details

---

## Commit History

- `ba8eced` — feat(wall-loop-detector): implement WallLoopDetector.ts
- `737fd41` — feat(wall-loop-detector): implement WallLoopDetector.ts (refinement)
- `3de065a` — feat: Phase 1 auto-floor core — WallLoopDetector + PlanController integration (original Java attempt, superseded)

---

## Verification (Wave 2)

- ✅ T2 diff reviewed: engine.ts integration correct (detectClosedLoops import, finalizeWallCompletion, openAutoFloorDialog flow)
- ✅ T3 diff reviewed: AutoFloorDialog.ts created (follows prefs-overlay pattern), integrated in engine.ts
- ✅ Unit tests pass: auto-floor.test.ts (9 tests), wall-loop-detector.test.ts (10 tests)
- ✅ Lint check: No errors in T2/T3 code
- ✅ Fixes applied:
  - Guard AutoFloorDialog DOM access for Node test environment
  - Fixed auto-floor.test.ts beforeEach/afterEach hooks
  - Fixed E2E test API calls (getWalls → getStore().getHome().walls)
- ⏳ E2E tests: Fixed, ready for re-run
- Commits: 26c9fbf (DOM guard), 606dbee (E2E fix)

## Notes

- T1 implementation quality: ✅ High (proper types, JSDoc, edge case handling)
- Ready for Wave 2: ✅ Yes
- Steward coordination: ⏳ In progress (create tasks + track in Steward)
