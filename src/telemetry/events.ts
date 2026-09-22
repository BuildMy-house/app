/**
 * Telemetry event type definitions. Tier 1 = always on, Tier 2 = opt-out.
 *
 * Every event has:
 *   event: string        – dotted event name
 *   tier: 1 | 2          – visibility tier
 *   ts: string           – ISO-8601 timestamp
 *   sid: string          – session ID
 *   app: string          – "buildmy-house"
 *   ver: string          – app version
 */

export type TelemetryTier = 1 | 2

interface BaseEvent {
  event: string
  tier: TelemetryTier
  ts: string
  sid: string
  app: string
  ver: string
}

// ── Tier 1: Software Health (always on) ─────────────────────────────────────

interface ErrorCaughtEvent extends BaseEvent {
  event: 'error.caught'
  tier: 1
  message: string
  stack?: string
  source: 'window.onerror' | 'unhandledrejection' | 'catch'
}

interface WebglContextLostEvent extends BaseEvent {
  event: 'webgl.context_lost'
  tier: 1
}

interface FrameTimeEvent extends BaseEvent {
  event: 'perf.frame_time'
  tier: 1
  p50: number
  p95: number
  p99: number
  samples: number
}

interface PlanRenderEvent extends BaseEvent {
  event: 'perf.plan_render'
  tier: 1
  durationMs: number
  wallCount: number
  furnitureCount: number
}

interface CatalogLoadEvent extends BaseEvent {
  event: 'perf.catalog_load'
  tier: 1
  durationMs: number
  itemCount: number
}

interface FileIoEvent extends BaseEvent {
  event: 'file.io'
  tier: 1
  op: 'save' | 'open' | 'export_png' | 'import_model'
  durationMs: number
  path?: string
  success: boolean
  error?: string
}

interface AssetMetricsEvent extends BaseEvent {
  event: 'perf.asset_metrics'
  tier: 1
  textureLoadDurationMs: number
  textureMemoryMB: number
  textureCount: number
  modelLoadCount: number
  avgModelLoadDurationMs: number
  totalAssetBundleSizeMB: number
  /** 0-1, how many texture loads were cache reuses vs newly loaded. */
  cacheHitRate: number
  /** Texture ids seen this reporting window (for cache tracking). */
  loadedTextureIds: string[]
}

interface AppLifecycleEvent extends BaseEvent {
  event: 'app.start' | 'app.exit' | 'app.focus' | 'app.blur'
  tier: 1
}

interface AutomationEvent extends BaseEvent {
  event: 'automation.connect' | 'automation.disconnect' | 'automation.command'
  tier: 1
  command?: string
  durationMs?: number
}

/** Payload for periodic renderer stats (collected every 30 frames, reported every 30s). */
export interface RenderingMetrics {
  drawCalls: number
  instancedMeshCount: number
  triangleCount: number
  textureMemoryMB: number
  fps: number
}

export interface RenderingMetricsEvent extends BaseEvent, RenderingMetrics {
  event: 'perf.rendering_metrics'
  tier: 1
}

// ── Tier 2: User Interaction (opt-out) ──────────────────────────────────────

interface ToolUsageEvent extends BaseEvent {
  event: 'tool.switch' | 'tool.wall_click' | 'tool.furniture_place'
  tier: 2
  tool: string
}

interface FeatureUsageEvent extends BaseEvent {
  event: 'feature.undo' | 'feature.redo' | 'feature.room_add'
    | 'feature.level_add' | 'feature.door_window' | 'feature.save'
    | 'feature.open' | 'feature.export'
  tier: 2
}

/** User action performance trace (Tier 2): what the user did, how long it took,
 *  and how scene complexity / frame time moved around the action. */
interface UserActionMetricsEvent extends BaseEvent {
  event: 'user.action_trace'
  tier: 2
  actionName: string
  durationMs: number
  sceneComplexityBefore: number
  sceneComplexityAfter: number
  frameTimeDeltaMs: number
  success: boolean
  errorMessage?: string
}

export type TelemetryEvent =
  | ErrorCaughtEvent
  | WebglContextLostEvent
  | FrameTimeEvent
  | PlanRenderEvent
  | CatalogLoadEvent
  | AssetMetricsEvent
  | FileIoEvent
  | AppLifecycleEvent
  | AutomationEvent
  | RenderingMetricsEvent
  | ToolUsageEvent
  | FeatureUsageEvent
  | UserActionMetricsEvent
