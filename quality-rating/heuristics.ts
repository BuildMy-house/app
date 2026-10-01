import type { ViewportQualitySnapshot } from '../src/telemetry/events'

/**
 * Pure heuristic grading of a ViewportQualitySnapshot. No DOM, no I/O — safe
 * to unit-test and to reuse from any runner.
 *
 * Threshold rationale (documented deliberately, tuned against a dev-machine
 * RTX + SwiftShader CI spread):
 *
 * - Frame spikes: a sample is a "spike" when it exceeds 2× the median of the
 *   sampled window. Needs ≥ 6 samples to say anything (below that the window
 *   is ignored — warm-up frames and RAF jitter dominate). spikeRatio > 0.2 is
 *   a hard fail (a fifth of frames hitching means the scene is unusable);
 *   any smaller spike presence is a soft flag.
 * - triangleCount === 0 while objects exist is a hard fail: the renderer ran
 *   but drew nothing — broken assets/scene graph, invisible to the user.
 * - triangleCount > 0 with zero objects is a hard fail: geometry leaked into
 *   an empty scene (or counts are being reported wrong).
 * - > 150k triangles per object on average is a soft flag (asset not
 *   LOD-authored / oversized GLB).
 * - drawCalls > 4 × (furniture + walls + rooms) + 100 is a soft flag: a
 *   scene this simple should stay well under a few hundred calls; runaway
 *   draw calls indicate broken instancing/batching.
 * - LOD flag: when the caller marks LOD culling as expected for this scene
 *   (context.expectedLodCullScreenFraction > 0) but drawCalls still exceed
 *   4 × furnitureCount + 100, culling is probably not doing its job. The
 *   shipped preset fields are `lodCullScreenFraction` /
 *   `transparentLodCullScreenFraction` (screen-fraction, DPI-independent —
 *   see viewport-quality.ts); expectedLodCullScreenFraction here is still
 *   only used as a boolean "culling is expected for this scene" signal, not
 *   compared numerically against the preset's own fraction — a scene is
 *   either furnished enough that *some* culling should show up, or it isn't.
 *
 * Score: 100 − 40 × hard − 15 × soft, floored at 0.
 * Verdict: any hard reason → fail; any soft reason → borderline; else pass.
 */
export interface GradeContext {
  /** > 0 marks the scene as one where LOD culling should be visibly reducing draw calls. */
  expectedLodCullScreenFraction: number
  /** Rolling per-frame deltas (ms) sampled via RAF; ignored below 6 samples. */
  priorFrameTimesMs?: number[]
}

export interface Grade {
  score: number
  verdict: 'pass' | 'borderline' | 'fail'
  reasons: string[]
}

export function gradeHeuristics(snapshot: ViewportQualitySnapshot, context: GradeContext): Grade {
  const hard: string[] = []
  const soft: string[] = []

  const frames = context.priorFrameTimesMs ?? []
  if (frames.length >= 6) {
    const sorted = [...frames].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const spikes = frames.filter((t) => t > 2 * median).length
    const ratio = spikes / frames.length
    if (ratio > 0.2) {
      hard.push(`frame spike ratio ${(ratio * 100).toFixed(0)}% > 20% (median ${median.toFixed(1)}ms)`)
    } else if (spikes > 0) {
      soft.push(`${spikes}/${frames.length} frame spikes > 2× median`)
    }
  }

  const objects = snapshot.furnitureCount + snapshot.wallCount + snapshot.roomCount

  if (objects > 0 && snapshot.triangleCount === 0) {
    hard.push(`triangleCount is 0 with ${objects} objects present — nothing rendered`)
  }
  if (objects === 0 && snapshot.triangleCount > 0) {
    hard.push(`triangleCount is ${snapshot.triangleCount} in an empty scene`)
  }

  if (objects > 0 && snapshot.triangleCount / objects > 150_000) {
    soft.push(`avg triangles/object ${(snapshot.triangleCount / objects).toFixed(0)} > 150k`)
  }

  const drawBudget = 4 * objects + 100
  if (snapshot.drawCalls > drawBudget) {
    soft.push(`drawCalls ${snapshot.drawCalls} > budget ${drawBudget}`)
  }

  const lodExpected = context.expectedLodCullScreenFraction > 0
  if (lodExpected && snapshot.furnitureCount > 0 && snapshot.drawCalls > 4 * snapshot.furnitureCount + 100) {
    soft.push(`LOD culling expected but drawCalls ${snapshot.drawCalls} > ${4 * snapshot.furnitureCount + 100}`)
  }

  const score = Math.max(0, 100 - 40 * hard.length - 15 * soft.length)
  const verdict: Grade['verdict'] = hard.length > 0 ? 'fail' : soft.length > 0 ? 'borderline' : 'pass'
  return { score, verdict, reasons: [...hard, ...soft] }
}
