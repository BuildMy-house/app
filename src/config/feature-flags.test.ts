import { describe, it, expect, beforeEach, vi } from 'vitest'
import { isMultiLevelEnabled } from './feature-flags'

describe('feature flags — isMultiLevelEnabled', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('unset → false (default off)', () => {
    vi.stubEnv('VITE_ENABLE_MULTI_LEVEL', undefined)
    expect(isMultiLevelEnabled()).toBe(false)
  })

  it("'true' → true", () => {
    vi.stubEnv('VITE_ENABLE_MULTI_LEVEL', 'true')
    expect(isMultiLevelEnabled()).toBe(true)
  })

  it("'false' → false", () => {
    vi.stubEnv('VITE_ENABLE_MULTI_LEVEL', 'false')
    expect(isMultiLevelEnabled()).toBe(false)
  })

  it('arbitrary string → false', () => {
    vi.stubEnv('VITE_ENABLE_MULTI_LEVEL', '1')
    expect(isMultiLevelEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_MULTI_LEVEL', 'TRUE')
    expect(isMultiLevelEnabled()).toBe(false)
  })
})
