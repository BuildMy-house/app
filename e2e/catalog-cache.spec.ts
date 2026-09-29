import { test, expect } from '@playwright/test'

/**
 * perf-catalog-1: the bundled manifest (~260KB, 100 items) cost every session
 * a 300-680ms network wait before the furniture sidebar rendered (prod
 * telemetry: perf.catalog_load avg 313ms / p95 669ms, 1:1 with app.start).
 * Startup now uses a localStorage cache with stale-while-revalidate, so a
 * repeat session renders the panel without waiting on the network.
 *
 * This spec emulates the prod fetch latency with a 400ms route delay and
 * asserts the timing from the real perf.catalog_load telemetry events:
 *   - first load (no cache): panel waits for the delayed fetch (~>=400ms)
 *   - reload (cache present): panel renders from cache well under the delay,
 *     and the fresh fetch only revalidates in the background.
 */

interface CatalogLoadEvent {
  event: string
  durationMs?: number
  itemCount?: number
}

const DELAY_MS = 400
const CACHE_KEY = 'buildmyhouse.catalog-manifest.v1'

async function readCatalogLoadEvent(page: import('@playwright/test').Page): Promise<CatalogLoadEvent | null> {
  return page.evaluate(() => {
    const evts =
      (window as unknown as { __telemetryEvents?: CatalogLoadEvent[] }).__telemetryEvents ?? []
    return evts.find((e) => e.event === 'perf.catalog_load') ?? null
  })
}

test.describe('catalog manifest cache (stale-while-revalidate)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/assets/catalog/catalog.json', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
      await route.continue()
    })
    await page.addInitScript(() => {
      ;(window as unknown as { __telemetryEvents: unknown[] }).__telemetryEvents = []
    })
  })

  test('cold load waits on the network, reload renders from cache', async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('.catalog-card', { timeout: 15_000 })

    const cold = await readCatalogLoadEvent(page)
    expect(cold).not.toBeNull()
    expect(cold!.durationMs ?? 0).toBeGreaterThanOrEqual(DELAY_MS)
    expect(cold!.itemCount).toBeGreaterThan(0)
    // The fetched manifest was persisted for the next session.
    expect(await page.evaluate((key) => localStorage.getItem(key) !== null, CACHE_KEY)).toBe(true)

    const coldDuration = cold!.durationMs ?? 0

    await page.reload()
    await page.waitForSelector('.catalog-card', { timeout: 15_000 })

    const warm = await readCatalogLoadEvent(page)
    expect(warm).not.toBeNull()
    expect(warm!.itemCount).toBe(cold!.itemCount)
    // Cache path must beat the still-delayed background revalidation fetch.
    // Headroom note: warm ≈ parse + panel DOM build (~200ms on this machine);
    // DELAY_MS is the failure bound — a broken cache path waits >= DELAY_MS.
    expect(warm!.durationMs ?? Infinity).toBeLessThan(DELAY_MS)

    console.log(      `[catalog-cache] cold(uncached)=${coldDuration.toFixed(1)}ms warm(cache)=${(warm!.durationMs ?? -1).toFixed(1)}ms`,
    )
  })
})
