import { describe, it, expect, vi, beforeEach } from 'vitest'

const userActionMetrics = vi.fn()

vi.mock('./logger', () => ({
  telemetry: { userActionMetrics: (...args: unknown[]) => userActionMetrics(...args) },
}))

import { traceAction, initActionTrace } from './trace'

describe('traceAction', () => {
  let scene: number
  let frameMs: number

  beforeEach(() => {
    userActionMetrics.mockClear()
    scene = 5
    frameMs = 16
    initActionTrace({
      getSceneComplexity: () => scene,
      getLastFrameTime: () => frameMs,
    })
  })

  it('emits user.action_trace (tier 2) with timing and complexity on success', async () => {
    await traceAction('wall.click', () => {
      scene = 6
      frameMs = 24
    })

    expect(userActionMetrics).toHaveBeenCalledTimes(1)
    const m = userActionMetrics.mock.calls[0]![0] as Record<string, unknown>
    expect(m.actionName).toBe('wall.click')
    expect(m.success).toBe(true)
    expect(m.sceneComplexityBefore).toBe(5)
    expect(m.sceneComplexityAfter).toBe(6)
    expect(m.frameTimeDeltaMs).toBe(8)
    expect(typeof m.durationMs).toBe('number')
    expect(m.durationMs).toBeGreaterThanOrEqual(0)
    expect(m.errorMessage).toBeUndefined()
  })

  it('measures wall-clock duration for async actions', async () => {
    await traceAction('save', async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    const m = userActionMetrics.mock.calls[0]![0] as Record<string, number>
    expect(m.durationMs).toBeGreaterThanOrEqual(15)
  })

  it('captures errors: success=false + errorMessage, then rethrows', async () => {
    scene = 7
    await expect(
      traceAction('furniture.place', () => {
        scene = 8
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(userActionMetrics).toHaveBeenCalledTimes(1)
    const m = userActionMetrics.mock.calls[0]![0] as Record<string, unknown>
    expect(m.success).toBe(false)
    expect(m.errorMessage).toBe('boom')
    expect(m.sceneComplexityBefore).toBe(7)
    expect(m.sceneComplexityAfter).toBe(8)
    expect(m.frameTimeDeltaMs).toBe(0)
  })

  it('stringifies non-Error throwables', async () => {
    await expect(traceAction('open', () => Promise.reject('nope'))).rejects.toBe('nope')
    const m = userActionMetrics.mock.calls[0]![0] as Record<string, unknown>
    expect(m.errorMessage).toBe('nope')
  })

  it('adds <2ms overhead per action', async () => {
    const runs = 1000
    const start = performance.now()
    for (let i = 0; i < runs; i++) await traceAction('noop', () => {})
    const perAction = (performance.now() - start) / runs
    expect(perAction).toBeLessThan(2)
  })
})
