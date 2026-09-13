/**
 * User action tracing (ticket A4). Wraps an action, emits `user.action_trace`
 * with wall-clock duration, scene complexity before/after, and frame-time delta.
 * Tier 2 (opt-out, enabled by default) — gating happens in transport.enqueue.
 */

import { telemetry } from './logger'

export interface TraceContext {
  getSceneComplexity(): number
  getLastFrameTime(): number
}

let ctx: TraceContext = {
  getSceneComplexity: () => 0,
  getLastFrameTime: () => 0,
}

/** Wire the app's scene/frame-time sources. Call once at boot. */
export function initActionTrace(context: TraceContext): void {
  ctx = context
}

export async function traceAction(name: string, fn: () => void | Promise<void>): Promise<void> {
  const startedAt = performance.now()
  const sceneBefore = ctx.getSceneComplexity()
  const frameBefore = ctx.getLastFrameTime()

  try {
    await fn()
  } catch (err) {
    telemetry.userActionMetrics({
      actionName: name,
      durationMs: performance.now() - startedAt,
      sceneComplexityBefore: sceneBefore,
      sceneComplexityAfter: ctx.getSceneComplexity(),
      frameTimeDeltaMs: 0,
      success: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    })
    throw err
  }

  telemetry.userActionMetrics({
    actionName: name,
    durationMs: performance.now() - startedAt,
    sceneComplexityBefore: sceneBefore,
    sceneComplexityAfter: ctx.getSceneComplexity(),
    frameTimeDeltaMs: ctx.getLastFrameTime() - frameBefore,
    success: true,
  })
}
