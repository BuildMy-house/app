import { test, expect } from '@playwright/test'

function roomCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => (window as any).__model.getStore().getHome().rooms.length)
}

function wallCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => (window as any).__model.getStore().getHome().walls.length)
}

test.describe('wall-enclosure auto-detect via double-click (M64)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
    await page.waitForFunction(() => (window as any).__model, null, { timeout: 10_000 })
  })

  test('double-click inside a wall rectangle auto-creates a room', async ({ page }) => {
    // Draw a 4-wall rectangle
    await page.locator('button[data-tool="wall"]').click()
    await page.locator('#magnetism').uncheck({ force: true })

    const planCanvas = page.locator('#plan-canvas')
    const box = await planCanvas.boundingBox()
    expect(box).not.toBeNull()

    const x0 = box!.x + box!.width * 0.3
    const x1 = box!.x + box!.width * 0.7
    const y0 = box!.y + box!.height * 0.3
    const y1 = box!.y + box!.height * 0.7

    await page.mouse.click(x0, y0)
    await page.mouse.click(x1, y0)
    await page.mouse.click(x1, y1)
    await page.mouse.click(x0, y1)
    await page.mouse.dblclick(x0, y0) // close wall loop

    expect(await wallCount(page)).toBe(4)
    expect(await roomCount(page)).toBe(0)

    // Auto-floor dialog appears — dismiss it
    const dialog = page.locator('.auto-floor-dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.locator('.prefs-cancel').click()
    await expect(dialog).not.toBeVisible()

    // Switch back to the Selection tool (default tool)
    await page.locator('button[data-tool="selection"]').click()

    // Double-click inside the rectangle — should auto-create room
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    await page.mouse.dblclick(cx, cy)

    // Wait for room to appear
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 1)
    expect(await roomCount(page)).toBe(1)

    // Room should be selected
    const selection: string[] = await page.evaluate(
      () => (window as any).__model.getStore().getHome().selection,
    )
    expect(selection).toHaveLength(1)

    // Verify the created room has the right vertices (4 corners of the rectangle)
    const roomPoints = await page.evaluate(() => {
      const rooms = (window as any).__model.getStore().getHome().rooms
      return rooms[0].points
    })
    expect(roomPoints).toHaveLength(4)
  })

  test('auto-detect room is a single undo step', async ({ page }) => {
    // Draw a 4-wall rectangle
    await page.locator('button[data-tool="wall"]').click()
    await page.locator('#magnetism').uncheck({ force: true })

    const planCanvas = page.locator('#plan-canvas')
    const box = await planCanvas.boundingBox()
    expect(box).not.toBeNull()

    const x0 = box!.x + box!.width * 0.3
    const x1 = box!.x + box!.width * 0.7
    const y0 = box!.y + box!.height * 0.3
    const y1 = box!.y + box!.height * 0.7

    await page.mouse.click(x0, y0)
    await page.mouse.click(x1, y0)
    await page.mouse.click(x1, y1)
    await page.mouse.click(x0, y1)
    await page.mouse.dblclick(x0, y0)
    expect(await wallCount(page)).toBe(4)

    // Auto-floor dialog appears — dismiss it
    const dialog = page.locator('.auto-floor-dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.locator('.prefs-cancel').click()
    await expect(dialog).not.toBeVisible()

    // Switch back to the Selection tool and auto-detect
    await page.locator('button[data-tool="selection"]').click()
    await page.mouse.dblclick((x0 + x1) / 2, (y0 + y1) / 2)
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 1)

    // Undo should remove the room (single compound edit step)
    await page.keyboard.press('Control+z')
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 0)
    expect(await roomCount(page)).toBe(0)

    // Walls should still exist
    expect(await wallCount(page)).toBe(4)
  })

  test('double-click with Selection tool creates exactly one room and leaves no dialog', async ({ page }) => {
    // Draw a 4-wall rectangle
    await page.locator('button[data-tool="wall"]').click()
    await page.locator('#magnetism').uncheck({ force: true })

    const planCanvas = page.locator('#plan-canvas')
    const box = await planCanvas.boundingBox()
    expect(box).not.toBeNull()

    const x0 = box!.x + box!.width * 0.3
    const x1 = box!.x + box!.width * 0.7
    const y0 = box!.y + box!.height * 0.3
    const y1 = box!.y + box!.height * 0.7

    await page.mouse.click(x0, y0)
    await page.mouse.click(x1, y0)
    await page.mouse.click(x1, y1)
    await page.mouse.click(x0, y1)
    await page.mouse.dblclick(x0, y0) // close wall loop
    expect(await wallCount(page)).toBe(4)

    // Wall-completion auto-floor dialog appears — dismiss it
    const dialog = page.locator('.auto-floor-dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.locator('.prefs-cancel').click()
    await expect(dialog).not.toBeVisible()

    // Selection tool active, double-click inside the rectangle. The click
    // before the dblclick re-opens the AutoFloorDialog; the dblclick must
    // dismiss it and create exactly ONE room.
    await page.locator('button[data-tool="selection"]').click()
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    await page.mouse.dblclick(cx, cy)

    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 1)
    expect(await roomCount(page)).toBe(1)
    expect(await wallCount(page)).toBe(4)

    // No dialog left visible, no duplicate room
    await expect(page.locator('.auto-floor-dialog')).toHaveCount(0)
    expect(await roomCount(page)).toBe(1)
  })
})
