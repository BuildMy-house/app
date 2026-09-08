import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest'
import { initTelemetryConfig, _resetConfigForTesting } from '../src/telemetry/config'
import { enqueue, flush } from '../src/telemetry/transport'
import type { TelemetryEvent } from '../src/telemetry/events'

function fakeEvent(tier: 1 = 1): TelemetryEvent {
  return {
    event: 'app.start',
    tier,
    ts: new Date().toISOString(),
    sid: 'test-sid',
    app: 'homely',
    ver: '0.0.0',
  }
}

describe('telemetry deployment modes', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    _resetConfigForTesting()
    fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    _resetConfigForTesting()
  })

  it('local mode + no token → complete no-op (no fetch, no buffer)', () => {
    // Neither DATABASE_URL nor VITE_AXIOM_TOKEN set
    vi.stubEnv('DATABASE_URL', '')
    vi.stubEnv('VITE_AXIOM_TOKEN', '')

    const config = initTelemetryConfig()
    expect(config.enabled).toBe(false)
    expect(config.token).toBe('')

    enqueue(fakeEvent())
    // Buffer should remain empty — no fetch should fire
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('local mode + token set → opt-in telemetry sends', async () => {
    vi.stubEnv('DATABASE_URL', '')
    vi.stubEnv('VITE_AXIOM_TOKEN', 'test-token-123')

    const config = initTelemetryConfig()
    expect(config.enabled).toBe(true)
    expect(config.token).toBe('test-token-123')

    enqueue(fakeEvent())
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const call = fetchSpy.mock.calls?.[0]
    expect(call).toBeDefined()
    const [url, opts] = call as any[]
    expect(url).toContain('/ingest')
    expect(opts.headers['Authorization']).toBe('Bearer test-token-123')
  })

  it('webserver mode (DATABASE_URL set) → always sends when token present', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/db')
    vi.stubEnv('VITE_AXIOM_TOKEN', 'web-token-456')

    const config = initTelemetryConfig()
    expect(config.enabled).toBe(true)
    expect(config.token).toBe('web-token-456')

    enqueue(fakeEvent())
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('webserver mode without token → enabled but skips send silently', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/db')
    vi.stubEnv('VITE_AXIOM_TOKEN', '')

    const config = initTelemetryConfig()
    expect(config.enabled).toBe(true)
    expect(config.token).toBe('')

    enqueue(fakeEvent())
    await flush()
    // enabled=true but no token → transport returns early, no fetch
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('tier 2 event is dropped when tier2Enabled=false', async () => {
    vi.stubEnv('DATABASE_URL', '')
    vi.stubEnv('VITE_AXIOM_TOKEN', 'test-token')

    const config = initTelemetryConfig()
    config.tier2Enabled = false

    enqueue({ event: 'tool.switch', tier: 2, ts: new Date().toISOString(), sid: 'test-sid', app: 'homely', ver: '0.0.0', tool: 'wall' })
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
