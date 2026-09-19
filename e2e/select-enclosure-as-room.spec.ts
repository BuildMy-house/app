import { test, expect } from '@playwright/test'

// Selection-tool single-click inside a closed (not-yet-a-room) wall loop
// offers the AutoFloorDialog; confirming creates the room. Mirrors the
// harness in auto-floor.spec.ts.

test.describe('Select enclosure as room E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas')
    await page.waitForFunction(() => (window as any).__model)
  })

  async function roomCount(page: any): Promise<number> {
    return page.evaluate(() => (window as any).__model?.getStore()?.getHome()?.rooms?.length ?? 0)
  }

  async function waitForWallCount(page: any, n: number) {
    await page.waitForFunction(
      (expected: number) => ((window as any).__model?.getStore()?.getHome()?.walls?.length ?? 0) >= expected,
      n,
      { timeout: 10_000 },
    )
  }

  // Draws 4 walls forming a rectangle, cancels the finalization auto-floor
  // dialog so the loop exists WITHOUT a room yet.
  async function drawEnclosureAndCancel(page: any) {
    await page.locator('button[data-tool="wall"]').click()
    const canvas = page.locator('#plan-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('plan-canvas not found')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    const s = 80

    await page.mouse.click(cx - s, cy - s)
    await page.mouse.click(cx + s, cy - s)
    await waitForWallCount(page, 1)
    await page.mouse.click(cx + s, cy + s)
    await waitForWallCount(page, 2)
    await page.mouse.click(cx - s, cy + s)
    await waitForWallCount(page, 3)
    await page.mouse.dblclick(cx - s, cy - s)

    // Finalization auto-floor dialog: cancel so no room is created yet.
    const dialog = page.locator('.auto-floor-dialog')
    await expect(dialog).toBeVisible({ timeout: 3000 })
    await dialog.locator('button', { hasText: /cancel/i }).click()
    await expect(dialog).not.toBeVisible({ timeout: 3000 })
    expect(await roomCount(page)).toBe(0)
    return { cx, cy }
  }

  test('selection click inside enclosure offers dialog; create makes room', async ({ page }) => {
    const { cx, cy } = await drawEnclosureAndCancel(page)

    // Explicitly switch to the Selection tool, then single-click the interior
    // (away from any wall).
    await page.locator('button[data-tool="selection"]').click()
    await page.mouse.click(cx, cy)

    const dialog = page.locator('.auto-floor-dialog')
    await expect(dialog).toBeVisible({ timeout: 3000 })

    await dialog.locator('button', { hasText: /create/i }).click()
    await expect(dialog).not.toBeVisible({ timeout: 3000 })

    expect(await roomCount(page)).toBe(1)
  })

  test('selection click inside enclosure; cancel still creates no room', async ({ page }) => {
    const { cx, cy } = await drawEnclosureAndCancel(page)

    await page.locator('button[data-tool="selection"]').click()
    await page.mouse.click(cx, cy)

    const dialog = page.locator('.auto-floor-dialog')
    await expect(dialog).toBeVisible({ timeout: 3000 })
    await dialog.locator('button', { hasText: /cancel/i }).click()
    await expect(dialog).not.toBeVisible({ timeout: 3000 })

    expect(await roomCount(page)).toBe(0)
  })
})
