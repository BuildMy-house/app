import { describe, it, expect } from 'vitest'
import type {
  RenderingMetrics,
  RenderingMetricsEvent,
  TelemetryEvent,
  ViewportQualitySnapshot,
  ViewportQualitySnapshotEvent,
} from './events'

describe('RenderingMetricsEvent', () => {
  it('carries the documented perf.rendering_metrics shape', () => {
    const metrics: RenderingMetrics = {
      drawCalls: 42,
      instancedMeshCount: 3,
      triangleCount: 12000,
      wallCount: 30,
      furnitureCount: 42,
      roomCount: 5,
      textureMemoryMB: 64,
      fps: 59.94,
      frameTimeP95Ms: 19.1,
      renderCpuMs: 4.2,
      renderCpuP95Ms: 8.4,
      sceneUpdateMs: 12.5,
      sceneUpdatePath: 'delta',
      pixelRatio: 0.75,
      qualityPreset: 'medium',
      ao: 'none',
      bloom: true,
      interacting: true,
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
    expect(event.renderCpuMs).toBe(4.2)
    expect(event.sceneUpdateMs).toBe(12.5)
    expect(event.sceneUpdatePath).toBe('delta')
    expect(event.pixelRatio).toBe(0.75)
    expect(event.interacting).toBe(true)

    // Part of the TelemetryEvent union (compile-time check with a runtime guard).
    const union: TelemetryEvent = event
    expect(union.event).toBe('perf.rendering_metrics')
  })
})

describe('ViewportQualitySnapshotEvent', () => {
  it('carries the documented perf.viewport_quality_snapshot shape (metadata only, no image payload)', () => {
    const snapshot: ViewportQualitySnapshot = {
      camX: 1200.5,
      camY: 800,
      camZ: -340.2,
      yawDeg: 45,
      pitchDeg: -30,
      furnitureCount: 12,
      roomCount: 4,
      wallCount: 28,
      triangleCount: 45_000,
      drawCalls: 96,
      instancedMeshCount: 5,
      qualityPreset: 'high',
      shadowMapSize: 2048,
      ao: 'ssao',
      bloom: true,
      viewportWidthPx: 1280,
      viewportHeightPx: 720,
      pixelRatio: 1.5,
      gpuRenderer: 'ANGLE (NVIDIA GeForce RTX)',
    }

    const event: ViewportQualitySnapshotEvent = {
      event: 'perf.viewport_quality_snapshot',
      tier: 1,
      ts: new Date().toISOString(),
      sid: 'test-session',
      app: 'buildmy-house',
      ver: '0.1.0',
      ...snapshot,
    }

    expect(event.event).toBe('perf.viewport_quality_snapshot')
    expect(event.tier).toBe(1)
    expect(event.camX).toBe(1200.5)
    expect(event.yawDeg).toBe(45)
    expect(event.pitchDeg).toBe(-30)
    expect(event.triangleCount).toBe(45_000)
    expect(event.qualityPreset).toBe('high')
    expect(event.shadowMapSize).toBe(2048)
    expect(event.ao).toBe('ssao')
    expect(event.pixelRatio).toBe(1.5)
    expect(event.gpuRenderer).toBe('ANGLE (NVIDIA GeForce RTX)')

    // No screenshot/image fields — metadata only by design.
    const keys = Object.keys(event)
    expect(keys).not.toContain('screenshot')
    expect(keys).not.toContain('image')

    // Part of the TelemetryEvent union (compile-time check with a runtime guard).
    const union: TelemetryEvent = event
    expect(union.event).toBe('perf.viewport_quality_snapshot')
  })
})
