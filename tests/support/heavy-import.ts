import { vi } from 'vitest'

/**
 * Timeout for test files that dynamically `import('../src/main')`.
 *
 * main.ts pulls in the whole app graph (three.js, plan engine, panels), so the
 * first import in a worker is transform-bound and takes ~1s idle but well past
 * vitest's default 5s when the machine is loaded (pre-push hook + parallel
 * workers, load average >10). That is purely startup cost, not a behaviour the
 * tests assert on, so give those files headroom instead of the 5s default.
 * Real assertions are unchanged; a genuine hang still fails, just at 30s.
 */
export const HEAVY_IMPORT_TIMEOUT_MS = 30_000

/** Call once at the top of any test file that imports `src/main`. */
export function allowHeavyImport(): void {
  vi.setConfig({ testTimeout: HEAVY_IMPORT_TIMEOUT_MS, hookTimeout: HEAVY_IMPORT_TIMEOUT_MS })
}
