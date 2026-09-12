# Homely Phase 1: Auto-Floor Core — TODOs

## ✅ Wave 1: Complete

- [x] **T1: WallLoopDetector.ts** 
  - [x] Implement closed loop detection algorithm
  - [x] Export `detectClosedLoops(walls, tolerance): WallLoop[]`
  - [x] Add graph-based cycle detection
  - [x] Validate loops (area ≥ 0.1, ≥3 walls, degree-2)
  - File: `buildmyhouse/src/core/wall-loop-detector.ts`
  - Commits: ba8eced, 737fd41
  - Status: ✅ DONE

---

## ⏳ Wave 2: Ready for Dispatch

### T2: Auto-Floor Room Creation in PlanController
- [ ] Modify `buildmyhouse/src/plan/engine.ts`
- [ ] Import WallLoopDetector 
- [ ] Call `detectClosedLoops()` on wall finalization
- [ ] Extract inner polygon from detected loop
- [ ] Create Room object with polygon
- [ ] Integrate with existing room creation + undo/redo
- [ ] Test: walls → auto-room → undo/redo works
- Estimated: 3-4 hours
- Ready to dispatch: ✅ YES

### T3: Auto-Floor Confirmation Dialog
- [ ] Create `buildmyhouse/src/ui/AutoFloorDialog.tsx` (React component)
- [ ] Modify `buildmyhouse/src/plan/engine.ts` (state integration)
- [ ] Dialog shows: "Create room from closed walls?"
- [ ] Confirm button → trigger room creation (T2)
- [ ] Cancel button → discard auto-floor
- [ ] Integrate into wall completion flow
- [ ] Test: dialog appears, user controls work
- Estimated: 2-3 hours
- Ready to dispatch: ✅ YES

---

## ⏳ Wave 3: Queued (After Wave 2)

### T4: Auto-Floor Test Suite
- [ ] Unit tests: `buildmyhouse/tests/wall-loop-detector.test.ts`
  - [ ] Rectangle, triangle, polygon shapes
  - [ ] T-junction rejection
  - [ ] Edge cases (open loops, small areas, etc.)
- [ ] Integration tests: `buildmyhouse/tests/auto-floor.test.ts`
  - [ ] Wall chain → room creation
  - [ ] Undo/redo of auto-created rooms
  - [ ] Dialog flow
- [ ] E2E tests: `buildmyhouse/e2e/auto-floor.spec.ts`
  - [ ] Playwright: draw walls → dialog → confirm → room visible
- [ ] Achieve >90% coverage
- [ ] All tests pass, no regressions
- Estimated: 3-5 hours
- Ready to dispatch: ⏳ After T2/T3 merge

---

## File Scope Summary

| File | T1 | T2 | T3 | T4 | Status |
|------|----|----|----|----|--------|
| `src/core/wall-loop-detector.ts` | ✅ | - | - | ✅ | DONE |
| `src/plan/engine.ts` | - | ⏳ | ⏳ | - | LOCKED during T2/T3 |
| `src/ui/AutoFloorDialog.tsx` | - | - | ⏳ | - | READY |
| `tests/wall-loop-detector.test.ts` | - | - | - | ⏳ | READY |
| `tests/auto-floor.test.ts` | - | - | - | ⏳ | READY |

---

## Dispatch Status

| Wave | Tickets | Status | Next Action |
|------|---------|--------|-------------|
| 1 | T1 | ✅ COMPLETE | Monitor/verify |
| 2 | T2, T3 | ⏳ READY | Dispatch parallel |
| 3 | T4 | ⏳ QUEUED | Dispatch after Wave 2 |

---

## Critical Path

```
T1 (DONE) 
  ↓
T2 + T3 (parallel, both depend on T1)
  ↓
T4 (depends on T2+T3)
  ↓
✅ Phase 1 Complete
```

**Estimated Total Time:** 11-15 hours from T1 start to full completion

---

## Steward ACS Coordination

- [ ] Create Phase 1 coordination task in Steward
- [ ] Mark T1 as completed in Steward (commit: ba8eced)
- [ ] Create T2 task in Steward + assign worker
- [ ] Create T3 task in Steward + assign worker
- [ ] Lock `src/plan/engine.ts` during T2/T3 execution
- [ ] After T2/T3 merge: unlock, create T4 task
- [ ] Mark all tasks done when Phase 1 complete

---

## Notes

- T1 quality: High ✅ (proper TypeScript, JSDoc, edge case handling)
- Wave 2 can start immediately: ✅ Yes
- File collision risk: Medium ⚠️ (both T2/T3 modify engine.ts)
- Mitigation: Use Steward file locking for coordination
