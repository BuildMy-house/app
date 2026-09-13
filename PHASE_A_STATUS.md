# Phase A Telemetry Collection — Dispatch Status

**Dispatch Date:** 2026-09-13 16:51 UTC+6  
**Status:** IN PROGRESS (all 4 tickets running in parallel)  
**Expected Completion:** ~17:30 UTC+6 (8h total phase, 4 workers concurrent)

## Tickets Dispatched

### A1: Rendering Metrics Collection ✓ IMPLEMENTED
**PID:** 733226  
**Status:** Code complete, tests passing, awaiting commit  
**Model:** zai-coding-plan/glm-5.3-flash  

**Implementation Summary:**
- Added `RenderingMetrics` interface: drawCalls, instancedMeshCount, triangleCount, textureMemoryMB, fps
- Added `RenderingMetricsEvent` (Tier 1) to events.ts
- Added `telemetry.renderingMetrics()` method to logger.ts
- Added collection in View3D.render() loop:
  - Samples every 30 frames via `collectRenderingMetrics()`
  - Reports every 30 seconds (batched with frameTime)
  - Uses Three.js renderer.info (zero overhead)
- Created comprehensive unit tests
- **Test Results:** 668 passing, 0 failing
- **Build:** ✓ Clean (882ms)
- **Lint:** ✓ Clean

**Files Modified:**
- src/telemetry/events.ts (+15 lines) - RenderingMetrics, RenderingMetricsEvent
- src/telemetry/logger.ts (+7 lines) - renderingMetrics() method
- src/telemetry/logger.test.ts (new)
- src/telemetry/events.test.ts (new)
- src/view3d/view.ts (+37 lines) - collection & reporting logic

### A2: Scene Delta Tracking ⏳ RUNNING
**PID:** 740918  
**Status:** Dispatched, working on scene-delta.ts hooks  
**Model:** zai-coding-plan/glm-5.3-flash  

**Scope:** Track delta vs full rebuild ratio (expected 80-90% delta)
- Hook scene-delta.ts for each operation type
- Measure timing per operation
- Report every 60 seconds with delta ratio

### A3: Asset Loading Metrics ⏳ RUNNING
**PID:** 740921  
**Status:** Dispatched, working on GLTFLoader hooks  
**Model:** zai-coding-plan/glm-5.3-flash  

**Scope:** Track texture memory and load times (baseline for Phase 3)
- Hook texture load measurement
- Cache hit rate tracking
- Report on app start + every 5 minutes

### A4: User Action Tracing ⏳ RUNNING
**PID:** 740924  
**Status:** Dispatched, working on main.ts tool handlers  
**Model:** zai-coding-plan/glm-5.3-flash  

**Scope:** Trace user actions with performance impact (Tier 2, opt-out)
- Wrap tool handlers (wall, furniture, room, level, etc.)
- Scene complexity tracking
- Frame time delta measurement

## Steward ACS Integration

**Repo:** house_designer  
**Branch:** feat/phase1-auto-floor-core  
**Tasks:**
- a1-rendering-metrics-collection [CLAIMED + CODE DONE]
- a2-scene-delta-tracking [CLAIMED + RUNNING]
- a3-asset-loading-metrics [CLAIMED + RUNNING]
- a4-user-action-tracing [RUNNING - offline task creation]

**File Locks:**
- A1 locked: events.ts, logger.ts, view.ts
- A2 locked: (pending file access)
- A3 locked: (pending file access)
- A4 locked: (pending file access)

## Next Steps After Completion

1. **Verify all commits** - Check git log for A1-A4 merge
2. **Run full test suite** - npm test -- --run (should pass all 668+)
3. **Verify Axiom integration** - Check telemetry transport logs
4. **Update Phase C plan** - Document actual metric names for queries
5. **Prepare Phase B** - Delta optimization based on A2 metrics

## Execution Timeline

- **16:51** A1 dispatched to opencode
- **16:51** A2, A3, A4 dispatched (parallel after A1 started)
- **~16:57** A1 implementation complete, tests passing
- **~17:10** Expected A2 completion
- **~17:10** Expected A3 completion  
- **~17:10** Expected A4 completion
- **~17:30** All four merged, full integration verified

## Technical Notes

- **A1 Pattern:** RenderingMetrics sampled every 30 frames, reported every 30s
- **Steward Coordination:** File locks ensure no conflicts when events.ts needs updates
- **Model Selection:** glm-5.3-flash (campaign window, cost-optimized)
- **No New Dependencies:** All collect via existing Three.js/view infrastructure
- **Tier Classification:** A1,A2,A3=Tier1 (always on), A4=Tier2 (opt-out)

