import { describe, it, expect } from 'vitest'
import type { RenderingMetrics, RenderingMetricsEvent, TelemetryEvent } from './events'

describe('RenderingMetricsEvent', () => {
  it('carries the documented perf.rendering_metrics shape', () => {
    const metrics: RenderingMetrics = {
      drawCalls: 42,
      instancedMeshCount: 3,
      triangleCount: 12000,
      textureMemoryMB: 64,
      fps: 59.94,
    }

    const event: RenderingMetricsEvent = {
      event: 'perf.rendering_metrics',
      tier: 1,
      ts: new Date().toISOString(),
      sid: 'test-session',
      app: 'buildmy-house',
      ver: '0.1.0',
      ...metrics,
    }

    expect(event.event).toBe('perf.rendering_metrics')
    expect(event.tier).toBe(1)
    expect(event.drawCalls).toBe(42)
    expect(event.instancedMeshCount).toBe(3)
    expect(event.triangleCount).toBe(12000)
    expect(event.textureMemoryMB).toBe(64)
    expect(event.fps).toBe(59.94)

    // Part of the TelemetryEvent union (compile-time check with a runtime guard).
    const union: TelemetryEvent = event
    expect(union.event).toBe('perf.rendering_metrics')
  })
})
