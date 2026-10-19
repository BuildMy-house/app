import { test, expect, type Page } from '@playwright/test'

// Floor creation UX: closing a wall loop creates its floor immediately,
// near-closed loops offer a one-click fix, the room tool finds enclosed areas.

test.describe('Floor creation E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas')
    await page.waitForFunction(() => (window as any).__model)
  })

  const counts = (page: Page) =>
    page.evaluate(() => {
      const h = (window as any).__model.getStore().getHome()
      return { rooms: h.rooms.length, walls: h.walls.length }
    })

  async function center(page: Page) {
    const box = await page.locator('#plan-canvas').boundingBox()
    if (!box) throw new Error('plan-canvas not found')
    return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 }
  }

  async function waitForWalls(page: Page, n: number) {
    await page.waitForFunction((k: number) => (window as any).__model.getStore().getHome().walls.length >= k, n, { timeout: 10_000 })
  }

  /** Draw a square of half-size `s` px; `closeAt` is the last click (offset from the start corner). */
  async function drawSquare(page: Page, closeAt: { dx: number; dy: number } | 'dblclick' = { dx: 0, dy: 0 }) {
    await page.locator('button[data-tool="wall"]').click()
    const { cx, cy } = await center(page)
    const s = 80
    await page.mouse.click(cx - s, cy - s)
    await page.mouse.click(cx + s, cy - s)
    await waitForWalls(page, 1)
    await page.mouse.click(cx + s, cy + s)
    await waitForWalls(page, 2)
    await page.mouse.click(cx - s, cy + s)
    await waitForWalls(page, 3)
    if (closeAt === 'dblclick') await page.mouse.dblclick(cx - s, cy - s)
    else await page.mouse.click(cx - s + closeAt.dx, cy - s + closeAt.dy)
    return { cx, cy, s }
  }

  test('a single click back on the start point closes the loop and creates the floor', async ({ page }) => {
    await drawSquare(page)
    await expect(page.locator('.toast-success')).toContainText('Floor created')
    expect(await counts(page)).toEqual({ rooms: 1, walls: 4 })
    // Drawing is finished: the next click must not extend a stale chain.
    await expect(page.locator('#status-tool')).not.toContainText('drawing')
  })

  test('double-click closing still yields exactly one floor', async ({ page }) => {
    await drawSquare(page, 'dblclick')
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length >= 1)
    await page.waitForTimeout(500)
    expect(await counts(page)).toEqual({ rooms: 1, walls: 4 })
  })

  test('undo removes the floor, then the walls; redo restores them', async ({ page }) => {
    await drawSquare(page)
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 1)
    await page.keyboard.press('Control+z')
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 0)
    expect((await counts(page)).walls).toBe(4)
    await page.keyboard.press('Control+z')
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().walls.length === 0)
    await page.keyboard.press('Control+y')
    await page.keyboard.press('Control+y')
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 1)
    expect(await counts(page)).toEqual({ rooms: 1, walls: 4 })
  })

  test('a loop that ends a few pixels short of the start still gets its floor', async ({ page }) => {
    await drawSquare(page, { dx: 0, dy: 8 })
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 1)
  })

  test('a loop with a clear gap shows the gap; clicking it closes the loop and creates the floor', async ({ page }) => {
    const { cx, cy } = await drawSquare(page, { dx: 0, dy: 70 })
    await page.keyboard.press('Escape')
    await expect(page.locator('.toast-notice')).toContainText(/gap/i)
    expect((await counts(page)).rooms).toBe(0)

    // The view re-fits after the first geometry, so find the gap on screen via
    // the status bar's cursor readout (model cm) instead of the pre-fit pixels.
    const readout = async (x: number, y: number) => {
      await page.mouse.move(x, y)
      await page.waitForTimeout(100)
      const t = (await page.locator('#status-cursor').innerText()).match(/x:\s*(-?[\d.]+)\s*y:\s*(-?[\d.]+)/)!
      return { mx: Number(t[1]), my: Number(t[2]) }
    }
    const p0 = await readout(cx, cy)
    const p1 = await readout(cx + 100, cy + 100)
    const k = 100 / (p1.mx - p0.mx)
    const gap = await page.evaluate(() => {
      const h = (window as any).__model.getStore().getHome()
      const last = h.walls[h.walls.length - 1]
      const first = h.walls[0]
      return { x: (last.xEnd + first.xStart) / 2, y: (last.yEnd + first.yStart) / 2 }
    })
    const gx = cx + (gap.x - p0.mx) * k
    const gy = cy + (gap.y - p0.my) * k
    await page.mouse.move(gx, gy)
    await page.mouse.click(gx, gy)
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 1)
    expect((await counts(page)).walls).toBe(5)
  })

  test('the floor survives a reload', async ({ page }) => {
    await drawSquare(page)
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 1)
    await page.waitForTimeout(1500) // autosave debounce
    await page.reload()
    await page.waitForFunction(() => (window as any).__model)
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 1)
    expect((await counts(page)).walls).toBe(4)
  })

  test('room tool: one click inside an enclosed area creates the floor', async ({ page }) => {
    await drawSquare(page)
    await page.keyboard.press('Control+z') // keep the walls, drop the auto floor
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 0)

    await page.locator('button[data-tool="room"]').click()
    const { cx, cy } = await center(page)
    await page.mouse.move(cx, cy)
    await page.waitForTimeout(250)
    await page.mouse.click(cx, cy)
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 1)
    expect((await counts(page)).walls).toBe(4)
  })

  test('room tool: corners then Enter finishes a floor; Esc cancels', async ({ page }) => {
    await page.locator('button[data-tool="room"]').click()
    const { cx, cy } = await center(page)
    await page.mouse.click(cx - 60, cy - 60)
    await page.mouse.click(cx + 60, cy - 60)
    await page.mouse.click(cx + 60, cy + 60)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().rooms.length === 1)

    await page.mouse.click(cx - 200, cy + 100)
    await page.mouse.click(cx - 150, cy + 100)
    await page.keyboard.press('Escape')
    expect((await counts(page)).rooms).toBe(1)
  })

  test('Room toolbar button shows the R hotkey in its tooltip', async ({ page }) => {
    await expect(page.locator('button[data-tool="room"]')).toHaveAttribute('title', /\(R\)|\bR\b/)
  })
})
