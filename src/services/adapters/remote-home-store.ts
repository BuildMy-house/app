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

export interface HomeUpdateEvent {
  type: 'home.updated'
  homeId: string
  revision: string
  actor: 'user' | 'agent'
  json: string
  name: string
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
  constructor(
    private readonly baseUrl = '/api/homes',
    private readonly getToken: () => string | null = () => null,
  ) {}

  /**
   * Shared fetch path. When a token is present, adds a Bearer Authorization
   * header; otherwise delegates to plain fetch. Single-argument calls are
   * preserved (no token → `fetch(url)`) so callers/tests can assert exact
   * call shapes.
   */
  private async request(url: string, init?: RequestInit): Promise<Response> {
    const token = this.getToken()
    if (!token) return init ? fetch(url, init) : fetch(url)
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)
    return fetch(url, { ...init, headers })
  }

  /** List the authenticated user's saved homes (summaries, no JSON blob). */
  async list(): Promise<RemoteHomeSummary[]> {
    const response = await this.request(this.baseUrl)
    if (!response.ok) throw new Error(`home library unavailable (${response.status})`)
    return ((await response.json()) as { items: RemoteHomeSummary[] }).items
  }

  /**
   * Save a home. Creates a new server home when no id is given; updates the
   * existing one when id is provided. Returns the persisted record.
   */
  async save(
    home: NormalizedHomeState,
    options: { id?: string; name?: string; baseUpdatedAt?: string; actor?: 'user' | 'agent' } = {},
  ): Promise<RemoteHome> {
    const body = {
      name: options.name,
      json: serializeForSave(home),
      ...(options.baseUpdatedAt ? { baseUpdatedAt: options.baseUpdatedAt } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
    }
    const response = await this.request(options.id ? `${this.baseUrl}/${encodeURIComponent(options.id)}` : this.baseUrl, {
      method: options.id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`home save failed (${response.status})`)
    return (await response.json()) as RemoteHome
  }

  /** Subscribe to revisioned updates from the same house while it is open. */
  async subscribe(id: string, onUpdate: (event: HomeUpdateEvent) => void): Promise<() => void> {
    const controller = new AbortController()
    const response = await this.request(`${this.baseUrl}/${encodeURIComponent(id)}/events`, { signal: controller.signal })
    if (!response.ok || !response.body) throw new Error(`home events unavailable (${response.status})`)
    void this.readEvents(response.body, onUpdate, controller.signal)
    return () => controller.abort()
  }

  async setPresence(id: string, role: 'user' | 'agent' = 'user'): Promise<void> {
    const response = await this.request(`${this.baseUrl}/${encodeURIComponent(id)}/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    })
    if (!response.ok) throw new Error(`home presence unavailable (${response.status})`)
  }

  private async readEvents(body: ReadableStream<Uint8Array>, onUpdate: (event: HomeUpdateEvent) => void, signal: AbortSignal): Promise<void> {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    try {
      while (!signal.aborted) {
        const next = await reader.read()
        if (next.done) break
        buffer += next.value
        const chunks = buffer.split('\n\n')
        buffer = chunks.pop() ?? ''
        for (const chunk of chunks) {
          const line = chunk.split('\n').find((entry) => entry.startsWith('data: '))
          if (line) onUpdate(JSON.parse(line.slice(6)) as HomeUpdateEvent)
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /** Load and parse a saved home by id. */
  async load(id: string): Promise<NormalizedHomeState> {
    return parseHomeFile((await this.loadRecord(id)).json)
  }

  /** Load a saved home and its revision metadata. */
  async loadRecord(id: string): Promise<RemoteHome> {
    const response = await this.request(`${this.baseUrl}/${encodeURIComponent(id)}`)
    if (!response.ok) throw new Error(`home load failed (${response.status})`)
    return (await response.json()) as RemoteHome
  }

  /** Delete a saved home by id. */
  async remove(id: string): Promise<void> {
    const response = await this.request(`${this.baseUrl}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!response.ok) throw new Error(`home removal failed (${response.status})`)
  }

  /**
   * Rename a saved home in place. The server's PUT requires the full json
   * blob, so this round-trips the existing one unchanged and only swaps the
   * name — callers never need to hold a loaded copy just to rename.
   */
  async rename(id: string, name: string): Promise<RemoteHome> {
    const getResponse = await this.request(`${this.baseUrl}/${encodeURIComponent(id)}`)
    if (!getResponse.ok) throw new Error(`home load failed (${getResponse.status})`)
    const record = (await getResponse.json()) as RemoteHome
    const putResponse = await this.request(`${this.baseUrl}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, json: record.json }),
    })
    if (!putResponse.ok) throw new Error(`home rename failed (${putResponse.status})`)
    return (await putResponse.json()) as RemoteHome
  }
}
