/**
 * HTTP batch transport for Axiom. Buffers events and flushes on batch size
 * or timer. Fire-and-forget: transport failures are silently dropped.
 */

import type { TelemetryEvent } from './events'
import { getTelemetryConfig } from './config'

let _buffer: TelemetryEvent[] = []
let _timer: ReturnType<typeof setTimeout> | null = null
let _flushing = false

/**
 * Chrome caps the total body of in-flight `keepalive` requests at ~64KB; a
 * larger body fails silently on unload. Keep each request comfortably under.
 */
const KEEPALIVE_CHUNK_BYTES = 60 * 1024

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Split a batch into keepalive-safe payloads without splitting an event. */
function chunkBatch(batch: TelemetryEvent[]): TelemetryEvent[][] {
  const chunks: TelemetryEvent[][] = []
  let current: TelemetryEvent[] = []
  let size = 2 // "[]"
  for (const event of batch) {
    const eventSize = byteLength(JSON.stringify(event)) + 1 // comma
    if (current.length > 0 && size + eventSize > KEEPALIVE_CHUNK_BYTES) {
      chunks.push(current)
      current = []
      size = 2
    }
    current.push(event)
    size += eventSize
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

async function postBatch(url: string, token: string, batch: TelemetryEvent[]): Promise<void> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
      keepalive: true,
    })
    if (!response.ok) console.warn(`[telemetry] Axiom ingest failed: HTTP ${response.status}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[telemetry] Axiom ingest failed:', message)
  }
}

/** Enqueue an event for batched delivery. */
export function enqueue(event: TelemetryEvent): void {
  const config = getTelemetryConfig()
  if (!config.enabled) return
  if (!config.token) return
  if (!config.endpoint) return
  if (event.tier === 2 && !config.tier2Enabled) return

  _buffer.push(event)
  if (_buffer.length >= config.batchSize) {
    void flush()
  } else if (!_timer) {
    _timer = setTimeout(() => {
      _timer = null
      void flush()
    }, config.flushIntervalMs)
  }
}

/** Flush all buffered events to Axiom. */
export async function flush(): Promise<void> {
  if (_flushing || _buffer.length === 0) return
  _flushing = true
  if (_timer) {
    clearTimeout(_timer)
    _timer = null
  }

  const batch = _buffer
  _buffer = []

  const config = getTelemetryConfig()
  if (!config.enabled || !config.token || !config.endpoint) {
    _flushing = false
    return
  }

  const url = `${config.endpoint}/v1/ingest/${config.dataset}`
  try {
    // All fetches are initiated synchronously so they survive page unload.
    await Promise.all(chunkBatch(batch).map((chunk) => postBatch(url, config.token, chunk)))
  } finally {
    _flushing = false
  }
}

/** Flush on page unload. */
export function registerUnload(): void {
  // 'visibilitychange' fires only on Document, never on Window (verified live
  // in Chromium 2026-09-29 -- registering this on `window` silently never
  // fired, so backgrounding a tab without fully closing it never flushed the
  // buffer at all; only the separate `pagehide` listener below ever ran).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush()
  })
  window.addEventListener('pagehide', () => void flush())
}
