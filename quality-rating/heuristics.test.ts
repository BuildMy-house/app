import { describe, expect, it } from 'vitest'
import { gradeHeuristics, type GradeContext } from './heuristics'
import type { ViewportQualitySnapshot } from '../src/telemetry/events'

function snap(overrides: Partial<ViewportQualitySnapshot> = {}): ViewportQualitySnapshot {
  return {
    camX: 0,
    camY: 8,
    camZ: 10,
    yawDeg: 0,
    pitchDeg: 45,
    furnitureCount: 5,
    roomCount: 1,
    wallCount: 4,
    triangleCount: 40_000,
    drawCalls: 80,
    instancedMeshCount: 2,
    qualityPreset: 'medium',
    shadowMapSize: 2048,
    ao: 'ssao',
    bloom: true,
    viewportWidthPx: 1280,
    viewportHeightPx: 720,
    pixelRatio: 1,
    gpuRenderer: 'test-gpu',
    ...overrides,
  }
}

const ctx: GradeContext = { expectedLodCullScreenFraction: 0 }

describe('gradeHeuristics', () => {
  it('passes a healthy snapshot with no frame data', () => {
    const g = gradeHeuristics(snap(), ctx)
    expect(g.verdict).toBe('pass')
    expect(g.score).toBe(100)
    expect(g.reasons).toHaveLength(0)
  })

  it('fails when objects exist but nothing rendered', () => {
    const g = gradeHeuristics(snap({ triangleCount: 0 }), ctx)
    expect(g.verdict).toBe('fail')
    expect(g.score).toBe(60)
    expect(g.reasons[0]).toContain('nothing rendered')
  })

  it('fails when geometry exists in an empty scene', () => {
    const g = gradeHeuristics(
      snap({ furnitureCount: 0, wallCount: 0, roomCount: 0, triangleCount: 500 }),
      ctx,
    )
    expect(g.verdict).toBe('fail')
    expect(g.reasons[0]).toContain('empty scene')
  })

  it('fails when more than 20% of frames spike', () => {
    const frames = [16, 16, 16, 16, 100, 16, 100, 100, 16, 16]
    const g = gradeHeuristics(snap(), { ...ctx, priorFrameTimesMs: frames })
    expect(g.verdict).toBe('fail')
    expect(g.reasons[0]).toContain('frame spike ratio')
  })

  it('is borderline with a few frame spikes', () => {
    const frames = [16, 16, 16, 16, 16, 16, 16, 100, 16, 16]
    const g = gradeHeuristics(snap(), { ...ctx, priorFrameTimesMs: frames })
    expect(g.verdict).toBe('borderline')
    expect(g.score).toBe(85)
  })

  it('ignores frame windows below 6 samples', () => {
    const g = gradeHeuristics(snap(), { ...ctx, priorFrameTimesMs: [16, 500, 900] })
    expect(g.verdict).toBe('pass')
  })

  it('is borderline on oversized geometry', () => {
    const g = gradeHeuristics(snap({ triangleCount: 2_000_000 }), ctx)
    expect(g.verdict).toBe('borderline')
    expect(g.reasons[0]).toContain('triangles/object')
  })

  it('is borderline when draw calls blow the budget', () => {
    const g = gradeHeuristics(snap({ drawCalls: 500 }), ctx)
    expect(g.verdict).toBe('borderline')
    expect(g.reasons[0]).toContain('drawCalls')
  })

  it('is borderline when LOD culling is expected but not observed', () => {
    const g = gradeHeuristics(snap({ drawCalls: 500 }), { expectedLodCullScreenFraction: 0.1 })
    expect(g.verdict).toBe('borderline')
    expect(g.reasons.some((r) => r.includes('LOD culling expected'))).toBe(true)
  })

  it('floors the score at 0 with many violations', () => {
    const g = gradeHeuristics(
      snap({ triangleCount: 0, drawCalls: 9999 }),
      { expectedLodCullScreenFraction: 0.1, priorFrameTimesMs: [16, 16, 16, 16, 400, 400] },
    )
    expect(g.score).toBe(0)
    expect(g.verdict).toBe('fail')
  })
})
