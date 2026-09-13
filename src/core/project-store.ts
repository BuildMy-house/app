import type { NormalizedHomeState } from './home'

/**
 * Persistence for the automation `save`/`open` commands.
 *
 * The clone runs in a WebView sandbox with no OS file access, so projects are
 * kept in `localStorage` keyed by the caller-supplied path (a real,
 * session-persistent round-trip — reopen the same path to get the home back).
 * `save` also returns the serialized JSON so an external orchestrator/MCP can
 * persist it to real disk if it chooses.
 */

const KEY_PREFIX = 'homely:project:'

function storage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    /* access can throw in sandboxed contexts */
  }
  return null
}

export function isNormalizedHome(value: unknown): value is NormalizedHomeState {
  if (!value || typeof value !== 'object') return false
  const h = value as Record<string, unknown>
  return (
    typeof h.schemaVersion === 'number' &&
    Array.isArray(h.levels) &&
    Array.isArray(h.walls) &&
    Array.isArray(h.rooms) &&
    Array.isArray(h.roofs) &&
    Array.isArray(h.furniture) &&
    Array.isArray(h.dimensionLines) &&
    Array.isArray(h.labels) &&
    Array.isArray(h.selection) &&
    h.cameras !== undefined &&
    h.compass !== undefined &&
    h.environment !== undefined
  )
}

export function saveProject(path: string, home: NormalizedHomeState): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(KEY_PREFIX + path, JSON.stringify(home))
  } catch {
    /* quota / serialization failure — caller still receives serialized json */
  }
}

export function loadProject(path: string): NormalizedHomeState | null {
  const s = storage()
  if (!s) return null
  try {
    const raw = s.getItem(KEY_PREFIX + path)
    return raw && isNormalizedHome(JSON.parse(raw)) ? (JSON.parse(raw) as NormalizedHomeState) : null
  } catch {
    return null
  }
}
