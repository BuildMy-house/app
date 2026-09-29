import { test, expect } from '@playwright/test'

/**
 * Follow-up to 9b7e6ab/b7d1d70 (see AGENTS.md history + view.ts's
 * reportMetricsNow()): the 30s/60s perf report timers armed on any
 * animation frame never fire for a session that ends before their window
 * elapses (tab closed, navigated away, backgrounded). This exercises the
 * best-effort fallback wired to visibilitychange('hidden')/pagehide,
 * confirming a real short editing session leaves at least one
 * perf.rendering_metrics AND perf.scene_delta_metrics row instead of zero.
 */

interface PerfEvent {
  event: string
  [key: string]: unknown
}

test.describe('perf telemetry coverage for short/backgrounded sessions', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as unknown as { __telemetryEvents: unknown[] }).__telemetryEvents = []
    })
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
    await page.waitForSelector('.catalog-card', { timeout: 10_000 })
  })

  test('backgrounding well under 30s after an edit still reports perf.rendering_metrics + perf.scene_delta_metrics', async ({
    page,
  }) => {
    // A real edit — places one piece of furniture, driving at least one
    // real animation frame/scene update (matches the arming comment in
    // view.ts's tick()).
    await page.locator('.catalog-card').first().click()
    const box = await page.locator('#plan-canvas').boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.55)

    // Let a couple of real animation frames run, then background the tab —
    // well under the 30s/60s report-timer windows this simulates a session
    // ending early (tab close/navigate-away hits the same pagehide path).
    await page.waitForTimeout(200)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    const renderingMetrics = await page.waitForFunction(
      () => {
        const evts = (window as unknown as { __telemetryEvents?: PerfEvent[] }).__telemetryEvents ?? []
        return evts.find((e) => e.event === 'perf.rendering_metrics') ?? null
      },
      undefined,
      { timeout: 5_000 },
    )
    expect(await renderingMetrics.jsonValue()).not.toBeNull()

    const events = await page.evaluate(
      () => (window as unknown as { __telemetryEvents?: PerfEvent[] }).__telemetryEvents ?? [],
    )
    expect(events.some((e) => e.event === 'perf.scene_delta_metrics')).toBe(true)
  })
})
