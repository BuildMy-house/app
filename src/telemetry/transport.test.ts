import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { TelemetryEvent } from './events'

const fetchMock = vi.fn()

function bigEvent(id: string, padBytes: number): TelemetryEvent {
  return {
    event: 'perf.frame_time',
    tier: 1,
    ts: new Date().toISOString(),
    sid: 'test-session',
    app: 'buildmy-house',
    ver: '0.1.0',
    p50: 1,
    p95: 2,
    p99: 3,
    samples: 1,
    id,
    pad: 'x'.repeat(padBytes),
  } as TelemetryEvent
}

function bodies(): string[] {
  return fetchMock.mock.calls.map((call) => (call[1] as { body: string }).body)
}

describe('transport keepalive chunking', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DATABASE_URL', undefined)
    vi.stubEnv('VITE_AXIOM_TOKEN', 'test-token')
    vi.stubEnv('VITE_AXIOM_ENDPOINT', 'https://axiom.test')
    vi.stubEnv('VITE_AXIOM_DATASET', 'test-dataset')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('splits an oversized batch into keepalive-safe requests under 60KB', async () => {
    const { enqueue, flush } = await import('./transport')

    for (let i = 0; i < 8; i++) enqueue(bigEvent(`e${i}`, 10_000))
    await flush()

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
    for (const body of bodies()) {
      expect(new TextEncoder().encode(body).length).toBeLessThan(60 * 1024)
    }
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as { keepalive?: boolean }).keepalive).toBe(true)
    }
  })

  it('delivers every event exactly once across the chunks', async () => {
    const { enqueue, flush } = await import('./transport')

    const ids = Array.from({ length: 8 }, (_, i) => `e${i}`)
    for (const [i, id] of ids.entries()) enqueue(bigEvent(id, 10_000))
    await flush()

    const delivered = bodies()
      .flatMap((body) => JSON.parse(body) as TelemetryEvent[])
      .map((event) => (event as unknown as { id: string }).id)
    expect(delivered.sort()).toEqual([...ids].sort())
  })

  it('sends a single small batch in one request', async () => {
    const { enqueue, flush } = await import('./transport')

    enqueue(bigEvent('one', 10))
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('still sends an individual event larger than the chunk limit', async () => {
    const { enqueue, flush } = await import('./transport')

    enqueue(bigEvent('huge', 70_000))
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(bodies()[0]!)[0].id).toBe('huge')
  })
})
