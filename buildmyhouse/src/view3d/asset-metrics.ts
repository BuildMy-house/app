/**
 * Asset loading metrics for Phase 3 texture optimization (Ticket A3).
 *
 * scene.ts feeds texture/model load events in; a 5-minute interval reports a
 * snapshot through telemetry.assetMetrics(). The first recorded load also
 * emits an immediate app-start baseline snapshot.
 *
 * Memory estimation: per texture, width * height * 4 bytes (RGBA), read from
 * the decoded image at collect time (dimensions are unavailable during the
 * async decode window between load() and onLoad).
 */
import type { Texture } from 'three'
import { telemetry } from '../telemetry/logger'

const REPORT_INTERVAL_MS = 5 * 60_000

export interface AssetMetricsSnapshot {
  textureLoadDurationMs: number
  textureMemoryMB: number
  textureCount: number
  modelLoadCount: number
  avgModelLoadDurationMs: number
  totalAssetBundleSizeMB: number
  cacheHitRate: number
  loadedTextureIds: string[]
}

/** Distinct textures seen since app start (id → texture, for memory estimate). */
const textureRegistry = new Map<string, Texture>()

// ── Reporting-window accumulators (reset by collectAssetMetrics) ────────────
let texLoads = 0
let texHits = 0
let texMissDurationMs = 0
let texIds = new Set<string>()
let windowAssetUrls = new Set<string>()
let modelLoads = 0
let modelMissDurationMs = 0

/**
 * Record one texture load operation. Cache hits pass durationMs 0; misses
 * pass the network+decode duration (measured in scene.ts via onLoad).
 * `texture` may be null for a known-failed load — skipped.
 */
export function recordTextureLoad(
  id: string,
  texture: Texture | null,
  durationMs: number,
  cacheHit: boolean,
  url?: string,
): void {
  ensureReporting()
  if (!texture) return
  texLoads++
  if (cacheHit) texHits++
  else texMissDurationMs += durationMs
  texIds.add(id)
  if (url) windowAssetUrls.add(url)
  if (!textureRegistry.has(id)) textureRegistry.set(id, texture)
}

/** Record one model load operation. Cache hits are only counted for hit rate. */
export function recordModelLoad(durationMs: number, cacheHit: boolean, url?: string): void {
  ensureReporting()
  if (cacheHit) return
  modelLoads++
  modelMissDurationMs += durationMs
  if (url) windowAssetUrls.add(url)
}

/** RGBA estimate: width * height * 4 bytes per decoded texture image. */
function estimateTextureMemoryBytes(): number {
  let bytes = 0
  for (const tex of textureRegistry.values()) {
    const img = tex.image as { width?: number; height?: number } | undefined
    if (img?.width && img?.height) bytes += img.width * img.height * 4
  }
  return bytes
}

/** Sum transfer size of this window's loaded assets from resource timings. */
function estimateBundleSizeBytes(urls: Set<string>): number {
  if (urls.size === 0) return 0
  const entries = (
    typeof performance !== 'undefined' && performance.getEntriesByType
      ? performance.getEntriesByType('resource')
      : []
  ) as PerformanceResourceTiming[]
  let bytes = 0
  for (const url of urls) {
    const entry = entries.find((e) => e.name === url)
    if (entry) bytes += entry.transferSize || entry.decodedBodySize || 0
  }
  return bytes
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** Build a snapshot and reset the reporting window (registry persists). */
export function collectAssetMetrics(): AssetMetricsSnapshot {
  const snapshot: AssetMetricsSnapshot = {
    textureLoadDurationMs: round2(texMissDurationMs),
    textureMemoryMB: round2(estimateTextureMemoryBytes() / (1024 * 1024)),
    textureCount: textureRegistry.size,
    modelLoadCount: modelLoads,
    avgModelLoadDurationMs: modelLoads > 0 ? round2(modelMissDurationMs / modelLoads) : 0,
    totalAssetBundleSizeMB: round2(estimateBundleSizeBytes(windowAssetUrls) / (1024 * 1024)),
    cacheHitRate: texLoads > 0 ? Math.round((texHits / texLoads) * 1000) / 1000 : 0,
    loadedTextureIds: [...texIds],
  }
  texLoads = 0
  texHits = 0
  texMissDurationMs = 0
  texIds = new Set()
  windowAssetUrls = new Set()
  modelLoads = 0
  modelMissDurationMs = 0
  return snapshot
}

let reportInterval: ReturnType<typeof setInterval> | null = null

function report(): void {
  telemetry.assetMetrics(collectAssetMetrics())
}

/** Start reporting on first recorded load (≈ app start) + every 5 minutes. */
function ensureReporting(): void {
  if (reportInterval) return
  report()
  reportInterval = setInterval(report, REPORT_INTERVAL_MS)
  // Don't hold the Node process open (vitest/SSR contexts).
  ;(reportInterval as unknown as { unref?: () => void }).unref?.()
}

export function stopAssetMetricsReporting(): void {
  if (reportInterval) {
    clearInterval(reportInterval)
    reportInterval = null
  }
}

/** Test-only: reset all collected state. */
export function resetAssetMetricsForTesting(): void {
  stopAssetMetricsReporting()
  textureRegistry.clear()
  texLoads = 0
  texHits = 0
  texMissDurationMs = 0
  texIds = new Set()
  windowAssetUrls = new Set()
  modelLoads = 0
  modelMissDurationMs = 0
}
