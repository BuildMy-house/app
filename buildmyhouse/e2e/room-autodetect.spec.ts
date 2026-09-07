import { test, expect } from '@playwright/test'

function roomCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => (window as any).__model.getStore().getHome().rooms.length)
}

function wallCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => (window as any).__model.getStore().getHome().walls.length)
}

test.describe('room tool auto-detect enclosure (M64)', () => {
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

    // Switch to room tool
    await page.locator('button[data-tool="room"]').click()

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

  test('double-click in open space falls back to manual drawing', async ({ page }) => {
    // Switch to room tool (no walls drawn)
    await page.locator('button[data-tool="room"]').click()

    const planCanvas = page.locator('#plan-canvas')
    const box = await planCanvas.boundingBox()
    expect(box).not.toBeNull()

    // Double-click in open space — should start manual drawing (no room yet)
    const cx = box!.x + box!.width * 0.5
    const cy = box!.y + box!.height * 0.5
    await page.mouse.dblclick(cx, cy)

    // Should have started drawing (1 point placed), but no room created yet
    expect(await roomCount(page)).toBe(0)

    // Status bar should indicate room drawing
    await expect(page.locator('#status-tool')).toContainText('room')
  })

  test('double-click closes a manually-drawn multi-point polygon', async ({ page }) => {
    // Draw a 4-wall rectangle for walls
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

    // Switch to room tool
    await page.locator('button[data-tool="room"]').click()

    // Manually place 3 polygon points (click, not dblclick)
    await page.mouse.click(x0 + 10, y0 + 10)
    await page.mouse.click(x1 - 10, y0 + 10)
    await page.mouse.click(x1 - 10, y1 - 10)

    // Should still be in drawing mode, no room yet
    expect(await roomCount(page)).toBe(0)

    // Double-click to close the manual polygon
    await page.mouse.dblclick(x0 + 10, y1 - 10)

    // Room should now exist
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 1)
    expect(await roomCount(page)).toBe(1)
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

    // Switch to room tool and auto-detect
    await page.locator('button[data-tool="room"]').click()
    await page.mouse.dblclick((x0 + x1) / 2, (y0 + y1) / 2)
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 1)

    // Undo should remove the room (single compound edit step)
    await page.keyboard.press('Control+z')
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 0)
    expect(await roomCount(page)).toBe(0)

    // Walls should still exist
    expect(await wallCount(page)).toBe(4)
  })
})
