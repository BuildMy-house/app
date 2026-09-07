/**
 * HTTP batch transport for Axiom. Buffers events and flushes on batch size
 * or timer. Fire-and-forget: transport failures are silently dropped.
 */

import type { TelemetryEvent } from './events'
import { getTelemetryConfig } from './config'

let _buffer: TelemetryEvent[] = []
let _timer: ReturnType<typeof setTimeout> | null = null
let _flushing = false

/** Enqueue an event for batched delivery. */
export function enqueue(event: TelemetryEvent): void {
  const config = getTelemetryConfig()
  if (!config.enabled) return
  if (!config.token) return
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
  if (!config.enabled || !config.token) {
    _flushing = false
    return
  }

  try {
    const url = `${config.endpoint}/api/v1/datasets/${config.dataset}/ingest`
    await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
      keepalive: true,
    })
  } catch {
    // Silently drop — telemetry must never break the app.
  } finally {
    _flushing = false
  }
}

/** Flush on page unload. */
export function registerUnload(): void {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush()
  })
  window.addEventListener('pagehide', () => void flush())
}
