/**
 * Telemetry configuration. Tier 1 (software health) is always on.
 * Tier 2 (user interaction) respects the user's opt-out preference.
 */

const PREFS_KEY = 'homely-preferences'

export interface TelemetryConfig {
  /** Axiom dataset name. */
  dataset: string
  /** Axiom API endpoint (cloud). */
  endpoint: string
  /** Axiom ingest API token (client-side token, write-only). */
  token: string
  /** Batch size before flush. */
  batchSize: number
  /** Max ms before forced flush. */
  flushIntervalMs: number
  /** Tier 2 enabled (user interaction events). */
  tier2Enabled: boolean
}

/** Read tier 2 preference from the same localStorage key as Preferences. */
function readTier2Preference(): boolean {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return true
    const prefs = JSON.parse(raw)
    return prefs.telemetryTier2 !== false
  } catch {
    return true
  }
}

let _config: TelemetryConfig | null = null

/**
 * Initialize telemetry config. Call once at app start.
 * Token comes from env (VITE_AXIOM_TOKEN) — never hardcoded.
 */
export function initTelemetryConfig(): TelemetryConfig {
  if (_config) return _config
  _config = {
    dataset: import.meta.env.VITE_AXIOM_DATASET as string ?? 'homely-telemetry',
    endpoint: (import.meta.env.VITE_AXIOM_ENDPOINT as string ?? 'https://api.axiom.co')
      .replace(/\/+$/, ''),
    token: import.meta.env.VITE_AXIOM_TOKEN as string ?? '',
    batchSize: 20,
    flushIntervalMs: 5000,
    tier2Enabled: readTier2Preference(),
  }
  return _config
}

export function getTelemetryConfig(): TelemetryConfig {
  if (!_config) return initTelemetryConfig()
  return _config
}

/** Update tier 2 preference (called from Preferences dialog). */
export function setTelemetryTier2(enabled: boolean): void {
  if (_config) _config.tier2Enabled = enabled
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    const prefs = raw ? JSON.parse(raw) : {}
    prefs.telemetryTier2 = enabled
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // best-effort
  }
}
