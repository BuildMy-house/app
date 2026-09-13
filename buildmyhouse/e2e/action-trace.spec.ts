import { test, expect } from '@playwright/test'

/**
 * Ticket A4: user action tracing. The app pushes every enqueued telemetry
 * event into window.__telemetryEvents (hook in transport.enqueue) when a test
 * pre-creates the array via addInitScript.
 */

interface ActionTraceEvent {
  event: string
  tier: number
  actionName: string
  durationMs: number
  sceneComplexityBefore: number
  sceneComplexityAfter: number
  frameTimeDeltaMs: number
  success: boolean
  errorMessage?: string
}

async function findTrace(page: import('@playwright/test').Page, actionName: string): Promise<ActionTraceEvent> {
  const handle = await page.waitForFunction(
    (name) => {
      const evts = (window as unknown as { __telemetryEvents?: unknown[] }).__telemetryEvents ?? []
      return evts.find((e) => (e as ActionTraceEvent).event === 'user.action_trace' && (e as ActionTraceEvent).actionName === name) ?? null
    },
    actionName,
    { timeout: 5_000 },
  )
  return (await handle.jsonValue()) as ActionTraceEvent
}

test.describe('user action tracing (A4)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as unknown as { __telemetryEvents: unknown[] }).__telemetryEvents = []
    })
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
    await page.waitForSelector('.catalog-card', { timeout: 10_000 })
  })

  test('placing furniture emits a traced action with timing and complexity', async ({ page }) => {
    await page.locator('.catalog-card').first().click()
    const box = await page.locator('#plan-canvas').boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.55)

    const evt = await findTrace(page, 'furniture.place')
    expect(evt.tier).toBe(2)
    expect(evt.success).toBe(true)
    expect(typeof evt.durationMs).toBe('number')
    expect(evt.durationMs).toBeGreaterThanOrEqual(0)
    expect(evt.sceneComplexityAfter).toBeGreaterThanOrEqual(1)
  })

  test('undo after placement emits an undo trace', async ({ page }) => {
    await page.locator('.catalog-card').first().click()
    const box = await page.locator('#plan-canvas').boundingBox()
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.55)

    await page.locator('#btn-undo').click()
    const evt = await findTrace(page, 'undo')
    expect(evt.success).toBe(true)
    expect(typeof evt.durationMs).toBe('number')
  })

  test('wall tool click emits a wall.click trace', async ({ page }) => {
    await page.locator('button[data-tool="wall"]').click()
    const plan = await page.locator('#plan-canvas').boundingBox()
    await page.mouse.click(plan!.x + plan!.width * 0.3, plan!.y + plan!.height * 0.5)

    const evt = await findTrace(page, 'wall.click')
    expect(evt.success).toBe(true)
  })
})
