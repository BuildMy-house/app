import { describe, it, expect, beforeEach, vi } from 'vitest'

const enqueue = vi.fn()

vi.mock('./transport', () => ({
  enqueue: (...args: unknown[]) => enqueue(...args),
  flush: vi.fn(async () => {}),
  registerUnload: vi.fn(),
}))

const METRICS = {
  drawCalls: 10,
  instancedMeshCount: 2,
  triangleCount: 3000,
  textureMemoryMB: 64,
  fps: 58.5,
}

describe('telemetry.renderingMetrics', () => {
  beforeEach(() => {
    vi.resetModules()
    enqueue.mockClear()
    vi.unstubAllEnvs()
    vi.stubEnv('DATABASE_URL', undefined)
  })

  it('emits perf.rendering_metrics as tier 1 with all metrics', async () => {
    vi.stubEnv('VITE_AXIOM_TOKEN', 'test-token')
    const { telemetry } = await import('./logger')

    telemetry.renderingMetrics(METRICS)

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      event: 'perf.rendering_metrics',
      tier: 1,
      drawCalls: 10,
      instancedMeshCount: 2,
      triangleCount: 3000,
      textureMemoryMB: 64,
      fps: 58.5,
    }))
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>
    expect(event).toHaveProperty('sid')
    expect(event).toHaveProperty('ts')
  })

  it('is a complete no-op when telemetry disabled (local mode, no token)', async () => {
    vi.stubEnv('VITE_AXIOM_TOKEN', '')
    const { telemetry } = await import('./logger')

    telemetry.renderingMetrics(METRICS)

    expect(enqueue).not.toHaveBeenCalled()
  })
})

describe('telemetry.userActionMetrics', () => {
  beforeEach(() => {
    vi.resetModules()
    enqueue.mockClear()
    vi.unstubAllEnvs()
    vi.stubEnv('DATABASE_URL', undefined)
  })

  it('emits user.action_trace as tier 2 with metrics', async () => {
    vi.stubEnv('VITE_AXIOM_TOKEN', 'test-token')
    const { telemetry } = await import('./logger')

    telemetry.userActionMetrics({
      actionName: 'furniture.place',
      durationMs: 12.5,
      sceneComplexityBefore: 3,
      sceneComplexityAfter: 4,
      frameTimeDeltaMs: 1.2,
      success: true,
    })

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      event: 'user.action_trace',
      tier: 2,
      actionName: 'furniture.place',
      durationMs: 12.5,
      sceneComplexityBefore: 3,
      sceneComplexityAfter: 4,
      frameTimeDeltaMs: 1.2,
      success: true,
    }))
  })

  it('carries errorMessage on failure', async () => {
    vi.stubEnv('VITE_AXIOM_TOKEN', 'test-token')
    const { telemetry } = await import('./logger')

    telemetry.userActionMetrics({
      actionName: 'open',
      durationMs: 5,
      sceneComplexityBefore: 0,
      sceneComplexityAfter: 0,
      frameTimeDeltaMs: 0,
      success: false,
      errorMessage: 'file corrupted',
    })

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      event: 'user.action_trace',
      success: false,
      errorMessage: 'file corrupted',
    }))
  })
})

describe('telemetry.track (generic escape hatch)', () => {
  beforeEach(() => {
    vi.resetModules()
    enqueue.mockClear()
    vi.unstubAllEnvs()
    vi.stubEnv('DATABASE_URL', undefined)
  })

  it('emits ad-hoc events without a dedicated typed method', async () => {
    vi.stubEnv('VITE_AXIOM_TOKEN', 'test-token')
    const { telemetry } = await import('./logger')

    telemetry.track('some.new.event', 1, { foo: 'bar' })

    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      event: 'some.new.event',
      tier: 1,
      foo: 'bar',
      app: 'buildmy-house',
    }))
  })

  it('is a no-op when telemetry disabled', async () => {
    vi.stubEnv('VITE_AXIOM_TOKEN', '')
    const { telemetry } = await import('./logger')

    telemetry.track('some.new.event', 2)

    expect(enqueue).not.toHaveBeenCalled()
  })
})
