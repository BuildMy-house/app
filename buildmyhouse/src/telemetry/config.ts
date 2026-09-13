/**
 * Telemetry configuration.
 *
 * Deployment modes:
 *   - Webserver mode (DATABASE_URL set): telemetry always on when token present
 *   - Local mode (DATABASE_URL unset): telemetry only on when token is also set (opt-in)
 *   - Local mode + no token: complete no-op, zero console noise
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
  /** Whether telemetry is active. False → complete no-op. */
  enabled: boolean
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
 * Detect if we're in webserver mode (DATABASE_URL is set in the environment).
 * In Vite browser context this will be undefined unless explicitly exposed
 * via VITE_ prefix or server config. Treat undefined as local mode.
 */
function isWebserverMode(): boolean {
  return !!import.meta.env.DATABASE_URL
}

/**
 * Initialize telemetry config. Call once at app start.
 * Token comes from env (VITE_AXIOM_TOKEN) — never hardcoded.
 */
export function initTelemetryConfig(): TelemetryConfig {
  if (_config) return _config

  const token = (import.meta.env.VITE_AXIOM_TOKEN as string) ?? ''
  const webserver = isWebserverMode()
  // Webserver mode: always enabled (sends when token present, skips silently if not).
  // Local mode: only enabled when token is explicitly set (opt-in).
  const enabled = webserver || !!token

  _config = {
    dataset: (import.meta.env.VITE_AXIOM_DATASET as string) ?? 'homely-telemetry',
    endpoint: ((import.meta.env.VITE_AXIOM_ENDPOINT as string) ?? 'https://api.axiom.co')
      .replace(/\/+$/, ''),
    token,
    batchSize: 20,
    flushIntervalMs: 5000,
    tier2Enabled: readTier2Preference(),
    enabled,
  }
  return _config
}

export function getTelemetryConfig(): TelemetryConfig {
  if (!_config) return initTelemetryConfig()
  return _config
}

/** Reset cached config (for tests only). */
export function _resetConfigForTesting(): void {
  _config = null
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
