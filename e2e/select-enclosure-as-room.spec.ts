import { test, expect } from '@playwright/test'

// Selection tool: double-click inside a closed (not-yet-a-room) wall loop
// creates its floor; a single click only selects / clears the selection.

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

  // Draws 4 walls forming a rectangle; closing the loop creates its floor, so
  // one undo takes it back and the loop exists WITHOUT a room yet.
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

    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 1)
    await page.keyboard.press('Control+z')
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 0)
    expect(await roomCount(page)).toBe(0)
    return { cx, cy }
  }

  test('selection double-click inside enclosure creates the room', async ({ page }) => {
    const { cx, cy } = await drawEnclosureAndCancel(page)

    await page.locator('button[data-tool="selection"]').click()
    await page.mouse.dblclick(cx, cy)

    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 1)
    expect(await roomCount(page)).toBe(1)
  })

  test('selection single click inside enclosure creates no room', async ({ page }) => {
    const { cx, cy } = await drawEnclosureAndCancel(page)

    await page.locator('button[data-tool="selection"]').click()
    await page.mouse.click(cx, cy)
    await page.waitForTimeout(400)

    expect(await roomCount(page)).toBe(0)
  })
})
