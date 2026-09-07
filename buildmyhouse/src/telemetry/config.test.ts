import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('telemetry config — deployment mode detection', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('local mode + no token → disabled (complete no-op)', async () => {
    vi.stubEnv('VITE_AXIOM_TOKEN', '')
    vi.stubEnv('DATABASE_URL', undefined)

    const { initTelemetryConfig } = await import('./config')
    const config = initTelemetryConfig()
    expect(config.enabled).toBe(false)
    expect(config.token).toBe('')
  })

  it('local mode + token → enabled (opt-in)', async () => {
    vi.stubEnv('VITE_AXIOM_TOKEN', 'test-token-123')
    vi.stubEnv('DATABASE_URL', undefined)

    const { initTelemetryConfig } = await import('./config')
    const config = initTelemetryConfig()
    expect(config.enabled).toBe(true)
    expect(config.token).toBe('test-token-123')
  })

  it('webserver mode (DATABASE_URL set) → enabled', async () => {
    vi.stubEnv('VITE_AXIOM_TOKEN', 'test-token-456')
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/db')

    const { initTelemetryConfig } = await import('./config')
    const config = initTelemetryConfig()
    expect(config.enabled).toBe(true)
    expect(config.token).toBe('test-token-456')
  })
})
