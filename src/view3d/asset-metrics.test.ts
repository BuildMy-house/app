import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Texture } from 'three'
import { telemetry } from '../telemetry/logger'
import {
  collectAssetMetrics,
  recordModelLoad,
  recordTextureLoad,
  resetAssetMetricsForTesting,
  stopAssetMetricsReporting,
} from './asset-metrics'

function fakeTexture(width: number, height: number): Texture {
  return { image: { width, height } } as unknown as Texture
}

describe('asset metrics (A3)', () => {
  beforeEach(() => {
    resetAssetMetricsForTesting()
  })

  it('estimates texture memory as width*height*4 within ±10%', () => {
    recordTextureLoad('t1', fakeTexture(512, 512), 5, false)
    recordTextureLoad('t2', fakeTexture(1024, 256), 5, false)
    const expectedMB = (512 * 512 * 4 + 1024 * 256 * 4) / (1024 * 1024)
    const snap = collectAssetMetrics()
    expect(snap.textureMemoryMB).toBeGreaterThanOrEqual(expectedMB * 0.9)
    expect(snap.textureMemoryMB).toBeLessThanOrEqual(expectedMB * 1.1)
    expect(snap.textureCount).toBe(2)
  })

  it('computes cache hit rate across repeated loads of the same texture', () => {
    const tex = fakeTexture(64, 64)
    recordTextureLoad('t', tex, 10, false)
    recordTextureLoad('t', tex, 0, true)
    recordTextureLoad('t', tex, 0, true)
    recordTextureLoad('t', tex, 0, true)
    const snap = collectAssetMetrics()
    expect(snap.cacheHitRate).toBe(0.75)
    expect(snap.loadedTextureIds).toEqual(['t'])
  })

  it('averages model load durations over actual (cache-miss) loads', () => {
    recordModelLoad(100, false, 'assets/m1.glb')
    recordModelLoad(300, false, 'assets/m2.glb')
    recordModelLoad(0, true, 'assets/m1.glb')
    const snap = collectAssetMetrics()
    expect(snap.modelLoadCount).toBe(2)
    expect(snap.avgModelLoadDurationMs).toBe(200)
  })

  it('resets the reporting window on collect but keeps the texture registry', () => {
    recordTextureLoad('t', fakeTexture(10, 10), 7, false)
    collectAssetMetrics()
    const snap = collectAssetMetrics()
    expect(snap.textureCount).toBe(1)
    expect(snap.loadedTextureIds).toEqual([])
    expect(snap.textureLoadDurationMs).toBe(0)
    expect(snap.cacheHitRate).toBe(0)
  })

  it('reports an app-start baseline, then every 5 minutes', () => {
    vi.useFakeTimers()
    try {
      const spy = vi.spyOn(telemetry, 'assetMetrics').mockImplementation(() => {})
      recordTextureLoad('t', fakeTexture(4, 4), 1, false)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]![0].textureCount).toBe(0)
      vi.advanceTimersByTime(5 * 60_000)
      expect(spy).toHaveBeenCalledTimes(2)
      expect(spy.mock.calls[1]![0].textureCount).toBe(1)
      expect(spy.mock.calls[1]![0].loadedTextureIds).toEqual(['t'])
      spy.mockRestore()
    } finally {
      vi.useRealTimers()
      stopAssetMetricsReporting()
    }
  })

  it('tracks assets in <1ms per load operation', () => {
    const tex = fakeTexture(8, 8)
    const ops = 10_000
    const t0 = performance.now()
    for (let i = 0; i < ops; i++) {
      recordTextureLoad(`t${i}`, tex, 1, i % 2 === 0)
      recordModelLoad(1, i % 2 === 1)
    }
    const perOpMs = (performance.now() - t0) / (ops * 2)
    expect(perOpMs).toBeLessThan(1)
  })
})
