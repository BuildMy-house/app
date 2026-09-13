/**
 * Server-side telemetry logger. Buffers events and flushes to Axiom
 * asynchronously. Never blocks the request path.
 *
 * Usage:
 *   import { serverTelemetry } from '../telemetry/logger.js'
 *   serverTelemetry.apiRequest({ method, path, statusCode, ... })
 */

export interface ApiRequestEvent {
  event: 'api.request'
  method: string
  path: string
  statusCode: number
  durationMs: number
  requestSize?: number
  responseSize?: number
  userId?: string
  ts: string
}

type TelemetryEvent = ApiRequestEvent

let _buffer: TelemetryEvent[] = []
let _timer: ReturnType<typeof setTimeout> | null = null
let _flushing = false
let _enabled = false
let _endpoint = ''
let _token = ''
let _dataset = ''

const BATCH_SIZE = 20
const FLUSH_INTERVAL_MS = 5000

export function initServerTelemetry(): void {
  _endpoint = (process.env.AXIOM_ENDPOINT ?? 'https://api.axiom.co').replace(/\/+$/, '')
  _token = process.env.AXIOM_TOKEN ?? ''
  _dataset = process.env.AXIOM_DATASET ?? 'homely-telemetry'
  _enabled = !!_token
}

function enqueue(event: TelemetryEvent): void {
  if (!_enabled) return
  _buffer.push(event)
  if (_buffer.length >= BATCH_SIZE) {
    void flush()
  } else if (!_timer) {
    _timer = setTimeout(() => {
      _timer = null
      void flush()
    }, FLUSH_INTERVAL_MS)
  }
}

async function flush(): Promise<void> {
  if (_flushing || _buffer.length === 0) return
  _flushing = true
  if (_timer) {
    clearTimeout(_timer)
    _timer = null
  }
  const batch = _buffer
  _buffer = []
  try {
    await fetch(`${_endpoint}/api/v1/datasets/${_dataset}/ingest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
    })
  } catch {
    // Telemetry must never break the app
  } finally {
    _flushing = false
  }
}

function shouldSample(statusCode: number, durationMs: number): boolean {
  if (statusCode >= 400) return true // 100% errors
  if (durationMs > 100) return true // 100% slow
  return Math.random() < 0.1 // 10% fast
}

export const serverTelemetry = {
  init: initServerTelemetry,

  apiRequest(data: {
    method: string
    path: string
    statusCode: number
    durationMs: number
    requestSize?: number
    responseSize?: number
    userId?: string
  }): void {
    if (!shouldSample(data.statusCode, data.durationMs)) return
    enqueue({
      event: 'api.request',
      ...data,
      ts: new Date().toISOString(),
    })
  },

  flush,
}
