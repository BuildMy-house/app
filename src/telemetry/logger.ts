/**
 * Public telemetry API. Import this module to emit events.
 *
 * Usage:
 *   import { telemetry } from './telemetry/logger'
 *   telemetry.appStart()
 *   telemetry.error(err, 'catch')
 *   telemetry.frameTime([16, 18, 22, 45, 120])
 */

import type { RenderingMetrics, TelemetryEvent, TelemetryTier } from './events'
import { getTelemetryConfig, initTelemetryConfig, setTelemetryTier2 } from './config'
import { getDeviceContext, getSessionId, getVersion, initContext } from './context'
import { enqueue, flush, registerUnload } from './transport'

function makeEvent(event: string, tier: TelemetryTier, extra?: Record<string, unknown>): TelemetryEvent {
  return {
    event,
    tier,
    ts: new Date().toISOString(),
    sid: getSessionId(),
    app: 'buildmy-house',
    ver: getVersion(),
    ...getDeviceContext(),
    ...extra,
  } as TelemetryEvent
}

function emit(event: string, tier: TelemetryTier, extra?: Record<string, unknown>): void {
  // ponytail: e2e/test observability hook — only exists when a test injects the
  // array (page.addInitScript); capped so long app sessions can't grow it.
  const hook = (globalThis as { __telemetryEvents?: TelemetryEvent[] }).__telemetryEvents
  hook?.push(makeEvent(event, tier, extra))
  if (hook && hook.length > 500) hook.splice(0, hook.length - 500)

  if (!getTelemetryConfig().enabled) return
  enqueue(makeEvent(event, tier, extra))
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)] ?? 0
}

export const telemetry = {
  /** Initialize telemetry. Call once at app start. */
  init(version?: string): void {
    const config = initTelemetryConfig()
    if (!config.enabled) return
    initContext(version ?? '0.1.0')
    registerUnload()
  },

  // ── Tier 1: Software Health ──────────────────────────────────────────────

  appStart(): void {
    emit('app.start', 1)
  },

  appExit(): void {
    emit('app.exit', 1)
  },

  appFocus(): void {
    emit('app.focus', 1)
  },

  appBlur(): void {
    emit('app.blur', 1)
  },

  error(err: unknown, source: 'window.onerror' | 'unhandledrejection' | 'catch'): void {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    emit('error.caught', 1, { message: msg, stack, source })
  },

  webglContextLost(): void {
    emit('webgl.context_lost', 1)
  },

  /** Report frame time percentiles from a window of samples (ms). */
  frameTime(samples: number[]): void {
    if (samples.length === 0) return
    const sorted = [...samples].sort((a, b) => a - b)
    emit('perf.frame_time', 1, {
      p50: Math.round(percentile(sorted, 50) * 100) / 100,
      p95: Math.round(percentile(sorted, 95) * 100) / 100,
      p99: Math.round(percentile(sorted, 99) * 100) / 100,
      samples: samples.length,
    })
  },

  planRender(durationMs: number, wallCount: number, furnitureCount: number): void {
    emit('perf.plan_render', 1, { durationMs, wallCount, furnitureCount })
  },

  catalogLoad(durationMs: number, itemCount: number): void {
    emit('perf.catalog_load', 1, { durationMs, itemCount })
  },

  /** Report asset loading metrics (textures, models, memory estimates). */
  assetMetrics(metrics: {
    textureLoadDurationMs: number
    textureMemoryMB: number
    textureCount: number
    modelLoadCount: number
    avgModelLoadDurationMs: number
    totalAssetBundleSizeMB: number
    cacheHitRate: number
    loadedTextureIds: string[]
  }): void {
    emit('perf.asset_metrics', 1, metrics)
  },

  fileIo(
    op: 'save' | 'open' | 'export_png' | 'import_model',
    durationMs: number,
    success: boolean,
    path?: string,
    error?: string,
  ): void {
    emit('file.io', 1, { op, durationMs, success, path, error })
  },

  automationConnect(): void {
    emit('automation.connect', 1)
  },

  automationDisconnect(): void {
    emit('automation.disconnect', 1)
  },

  automationCommand(command: string, durationMs?: number): void {
    emit('automation.command', 1, { command, durationMs })
  },

  /** Report renderer stats snapshot (draw calls, instancing, triangles, fps). */
  renderingMetrics(metrics: RenderingMetrics): void {
    emit('perf.rendering_metrics', 1, { ...metrics })
  },

  /** Report scene delta-vs-rebuild ratio for the last 60s window. */
  sceneDeltaMetrics(metrics: {
    deltaUpdatesCount: number
    fullRebuildsCount: number
    avgDeltaDurationMs: number
    avgRebuildDurationMs: number
    deltaRatio: number
    windowDurationMs: number
  }): void {
    emit('perf.scene_delta_metrics', 1, { ...metrics })
  },

  // ── Tier 2: User Interaction ─────────────────────────────────────────────

  toolSwitch(tool: string): void {
    emit('tool.switch', 2, { tool })
  },

  toolWallClick(): void {
    emit('tool.wall_click', 2)
  },

  toolFurniturePlace(): void {
    emit('tool.furniture_place', 2)
  },

  featureUndo(): void { emit('feature.undo', 2) },
  featureRedo(): void { emit('feature.redo', 2) },
  featureRoomAdd(): void { emit('feature.room_add', 2) },
  featureLevelAdd(): void { emit('feature.level_add', 2) },
  featureDoorWindow(): void { emit('feature.door_window', 2) },
  featureSave(): void { emit('feature.save', 2) },
  featureOpen(): void { emit('feature.open', 2) },
  featureExport(): void { emit('feature.export', 2) },

  /** Trace a user action with timing and scene complexity (ticket A4). */
  userActionMetrics(metrics: {
    actionName: string
    durationMs: number
    sceneComplexityBefore: number
    sceneComplexityAfter: number
    frameTimeDeltaMs: number
    success: boolean
    errorMessage?: string
  }): void {
    emit('user.action_trace', 2, { ...metrics })
  },

  // ── Generic escape hatch ─────────────────────────────────────────────────

  /** Emit an ad-hoc event without a dedicated typed method. */
  track(eventName: string, tier: TelemetryTier, payload?: Record<string, unknown>): void {
    emit(eventName, tier, payload)
  },

  // ── Preferences ──────────────────────────────────────────────────────────

  setTier2: setTelemetryTier2,

  get tier2Enabled(): boolean {
    return getTelemetryConfig().tier2Enabled
  },

  /** Force-flush remaining buffered events. */
  flush,
}
