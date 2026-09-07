/**
 * Telemetry event type definitions. Tier 1 = always on, Tier 2 = opt-out.
 *
 * Every event has:
 *   event: string        – dotted event name
 *   tier: 1 | 2          – visibility tier
 *   ts: string           – ISO-8601 timestamp
 *   sid: string          – session ID
 *   app: string          – "homely"
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

export interface ErrorCaughtEvent extends BaseEvent {
  event: 'error.caught'
  tier: 1
  message: string
  stack?: string
  source: 'window.onerror' | 'unhandledrejection' | 'catch'
}

export interface WebglContextLostEvent extends BaseEvent {
  event: 'webgl.context_lost'
  tier: 1
}

export interface FrameTimeEvent extends BaseEvent {
  event: 'perf.frame_time'
  tier: 1
  p50: number
  p95: number
  p99: number
  samples: number
}

export interface PlanRenderEvent extends BaseEvent {
  event: 'perf.plan_render'
  tier: 1
  durationMs: number
  wallCount: number
  furnitureCount: number
}

export interface CatalogLoadEvent extends BaseEvent {
  event: 'perf.catalog_load'
  tier: 1
  durationMs: number
  itemCount: number
}

export interface FileIoEvent extends BaseEvent {
  event: 'file.io'
  tier: 1
  op: 'save' | 'open' | 'export_png' | 'import_model'
  durationMs: number
  path?: string
  success: boolean
  error?: string
}

export interface AppLifecycleEvent extends BaseEvent {
  event: 'app.start' | 'app.exit' | 'app.focus' | 'app.blur'
  tier: 1
}

export interface AutomationEvent extends BaseEvent {
  event: 'automation.connect' | 'automation.disconnect' | 'automation.command'
  tier: 1
  command?: string
  durationMs?: number
}

// ── Tier 2: User Interaction (opt-out) ──────────────────────────────────────

export interface ToolUsageEvent extends BaseEvent {
  event: 'tool.switch' | 'tool.wall_click' | 'tool.furniture_place'
  tier: 2
  tool: string
}

export interface FeatureUsageEvent extends BaseEvent {
  event: 'feature.undo' | 'feature.redo' | 'feature.room_add'
    | 'feature.level_add' | 'feature.door_window' | 'feature.save'
    | 'feature.open' | 'feature.export'
  tier: 2
}

export type TelemetryEvent =
  | ErrorCaughtEvent
  | WebglContextLostEvent
  | FrameTimeEvent
  | PlanRenderEvent
  | CatalogLoadEvent
  | FileIoEvent
  | AppLifecycleEvent
  | AutomationEvent
  | ToolUsageEvent
  | FeatureUsageEvent
