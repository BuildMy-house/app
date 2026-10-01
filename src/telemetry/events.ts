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
  os?: string
  tauri?: string
  renderer?: string
  lang?: string
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
  /** True when served from the cached manifest instead of a network fetch. */
  cacheHit: boolean
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
  /** 0-1, how many model loads were cache reuses vs network+decode misses. */
  modelCacheHitRate: number
  totalAssetBundleSizeMB: number
  /** 0-1, how many texture loads were cache reuses vs newly loaded. */
  cacheHitRate: number
  /** Texture ids seen this reporting window (for cache tracking). */
  loadedTextureIds: string[]
}

interface AppBootEvent extends BaseEvent {
  event: 'perf.app_boot'
  tier: 1
  /** main.ts module body execution (DOM shell + UI construction). */
  bootMs: number
  /** DOMContentLoaded, ms since navigation start (null if unavailable). */
  dclMs: number | null
  /** Time to first byte, ms since navigation start (null if unavailable). */
  ttfbMs: number | null
}

interface ChunkLoadEvent extends BaseEvent {
  event: 'perf.chunk_load'
  tier: 1
  /** Dynamic-chunk identifier, e.g. 'user-catalog', 'gltf-loader', 'tauri-core'. */
  name: string
  durationMs: number
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
  wallCount: number
  furnitureCount: number
  roomCount: number
  textureMemoryMB: number
  fps: number
  frameTimeP95Ms: number
  renderCpuMs: number
  renderCpuP95Ms: number
  /** Scene-graph update phase: duration of the last full rebuild or delta
   *  batch (they are mutually exclusive per store change). 0 = none yet. */
  sceneUpdateMs: number
  /** Which scene-graph update phase sceneUpdateMs measures. Draw-call CPU
   *  time is already covered by renderCpuMs/renderCpuP95Ms. */
  sceneUpdatePath: 'rebuild' | 'delta' | 'none'
  pixelRatio: number
  qualityPreset: string
  ao: 'none' | 'ssao' | 'gtao'
  bloom: boolean
  interacting: boolean
}

export interface RenderingMetricsEvent extends BaseEvent, RenderingMetrics {
  event: 'perf.rendering_metrics'
  tier: 1
}

/** Payload for the 60s scene delta-vs-rebuild aggregation window. */
export interface SceneDeltaMetrics {
  deltaUpdatesCount: number
  fullRebuildsCount: number
  avgDeltaDurationMs: number
  avgRebuildDurationMs: number
  /** 0-1, share of applied deltas vs total scene updates. */
  deltaRatio: number
  windowDurationMs: number
  /** Delta counts per operation type. */
  deltaCountByType: Record<string, number>
  /** Full-rebuild counts per reason label (why the delta path was skipped). */
  rebuildCountByReason: Record<string, number>
}

export interface SceneDeltaMetricsEvent extends BaseEvent, SceneDeltaMetrics {
  event: 'perf.scene_delta_metrics'
  tier: 1
}

/** Per-asset catalog-ingestion payload (pipeline-side; emitted by the SH3D
 *  import pipeline, not the browser). Feeds the parked asset_quality_scores
 *  proposal with raw per-asset quality metadata. */
export interface AssetIngestionMetrics {
  catalogId: string
  /** Total triangles across all mesh primitives. */
  triangleCount: number
  meshCount: number
  textureCount: number
  /** One entry per material-referenced texture (deduped by texture index). */
  textures: { slot: string; width: number; height: number }[]
  /** PBR map slots present on at least one material (OR-aggregated). */
  pbrMapSlots: {
    baseColor: boolean
    normal: boolean
    ao: boolean
    metalnessRoughness: boolean
    emissive: boolean
  }
  /** true only when EVERY material's factor was explicitly authored. */
  metallicFactorAuthored: boolean
  /** true only when EVERY material's factor was explicitly authored. */
  roughnessFactorAuthored: boolean
}

export interface AssetIngestionEvent extends BaseEvent, AssetIngestionMetrics {
  event: 'perf.asset_ingestion'
  tier: 1
}

/** Scene-state + viewport METADATA ONLY — no screenshot/image payload (that is
 *  a separate, deliberately-not-built-yet concern). Collected on the same 30s
 *  throttled cadence as perf.rendering_metrics, reusing its computed stats. */
export interface ViewportQualitySnapshot {
  camX: number
  camY: number
  camZ: number
  /** App-world convention (matches CameraDirector state / applyCameraState),
   *  not raw three.js rotation, so rows join with camera commands. */
  yawDeg: number
  pitchDeg: number
  furnitureCount: number
  roomCount: number
  wallCount: number
  triangleCount: number
  drawCalls: number
  instancedMeshCount: number
  qualityPreset: string
  shadowMapSize: number
  ao: 'none' | 'ssao' | 'gtao'
  bloom: boolean
  /** Canvas size in CSS px (drawing buffer = this × pixelRatio). */
  viewportWidthPx: number
  viewportHeightPx: number
  /** Actually-applied devicePixelRatio (after cap/interaction scaling). */
  pixelRatio: number
  /** GPU string via WEBGL_debug_renderer_info; 'unknown' when unavailable. */
  gpuRenderer: string
}

export interface ViewportQualitySnapshotEvent extends BaseEvent, ViewportQualitySnapshot {
  event: 'perf.viewport_quality_snapshot'
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
  | AppBootEvent
  | ChunkLoadEvent
  | FileIoEvent
  | AppLifecycleEvent
  | AutomationEvent
  | RenderingMetricsEvent
  | SceneDeltaMetricsEvent
  | AssetIngestionEvent
  | ViewportQualitySnapshotEvent
  | ToolUsageEvent
  | FeatureUsageEvent
  | UserActionMetricsEvent
