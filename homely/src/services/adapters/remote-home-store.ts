import type { NormalizedHomeState } from '../../core/home'
import { parseHomeFile, serializeForSave } from './home-persistence'

/** Lightweight summary from the homes list endpoint (no JSON blob). */
export interface RemoteHomeSummary {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

/** Full home record (list entry + json blob). */
export interface RemoteHome {
  id: string
  name: string
  json: string
  createdAt: string
  updatedAt: string
}

/**
 * Server-backed home-project store ("Save to my account" / "Open from my
 * account"). Additive persistence path next to home-persistence.ts's local
 * file save/open — it serializes/parses with the same helpers, but persists
 * via the host's /api/homes endpoints instead of Tauri dialogs/browser
 * downloads. Homes are tenant-scoped server-side by the auth token; the
 * client never supplies an owner id.
 */
export class RemoteHomeStore {
  constructor(private readonly baseUrl = '/api/homes') {}

  /** List the authenticated user's saved homes (summaries, no JSON blob). */
  async list(): Promise<RemoteHomeSummary[]> {
    const response = await fetch(this.baseUrl)
    if (!response.ok) throw new Error(`home library unavailable (${response.status})`)
    return ((await response.json()) as { items: RemoteHomeSummary[] }).items
  }

  /**
   * Save a home. Creates a new server home when no id is given; updates the
   * existing one when id is provided. Returns the persisted record.
   */
  async save(
    home: NormalizedHomeState,
    options: { id?: string; name?: string } = {},
  ): Promise<RemoteHome> {
    const body = { name: options.name, json: serializeForSave(home) }
    const response = await fetch(options.id ? `${this.baseUrl}/${encodeURIComponent(options.id)}` : this.baseUrl, {
      method: options.id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`home save failed (${response.status})`)
    return (await response.json()) as RemoteHome
  }

  /** Load and parse a saved home by id. */
  async load(id: string): Promise<NormalizedHomeState> {
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(id)}`)
    if (!response.ok) throw new Error(`home load failed (${response.status})`)
    const record = (await response.json()) as RemoteHome
    return parseHomeFile(record.json)
  }

  /** Delete a saved home by id. */
  async remove(id: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!response.ok) throw new Error(`home removal failed (${response.status})`)
  }
}
