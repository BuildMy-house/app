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
