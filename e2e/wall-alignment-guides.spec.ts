import { test, expect, type Page } from '@playwright/test'

/**
 * Alignment smart guides while drawing walls: the cursor softly lines up with
 * existing vertices on the same horizontal / vertical line. Real mouse input,
 * screenshots of the guides before the click, and the committed geometry.
 */

const SHOTS = 'test-results/align-guides'

test.describe('wall alignment guides', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
    await page.locator('button[data-tool="wall"]').click()
  })

  async function walls(page: Page): Promise<Array<{ xStart: number; yStart: number; xEnd: number; yEnd: number }>> {
    return page.evaluate(() => (window as any).__model.getStore().getHome().walls)
  }

  async function box(page: Page) {
    return (await page.locator('#plan-canvas').boundingBox())!
  }

  // Draw a "C" shape: A -> B -> C. Vertices A, B, C stay on screen.
  async function drawC(page: Page) {
    const b = await box(page)
    const at = (fx: number, fy: number) => ({ x: b.x + b.width * fx, y: b.y + b.height * fy })
    const A = at(0.4, 0.35)
    const B = at(0.6, 0.35)
    const C = at(0.6, 0.65)
    await page.mouse.move(A.x, A.y)
    await page.mouse.click(A.x, A.y)
    await page.mouse.move(B.x, B.y, { steps: 6 })
    await page.mouse.click(B.x, B.y)
    await page.mouse.move(C.x, C.y, { steps: 6 })
    await page.mouse.click(C.x, C.y)
    return { A, B, C, at }
  }

  test('loop-closing: end snaps to the x of the first vertex with a guide', async ({ page }) => {
    const { A, C } = await drawC(page)
    // Cursor 6 px off the vertical line through A, heading west from C.
    await page.mouse.move(A.x + 40, C.y + 1, { steps: 6 })
    await page.mouse.move(A.x + 6, C.y + 2, { steps: 4 })
    await page.screenshot({ path: `${SHOTS}/1-single-guide-ray.png` })
    await page.mouse.click(A.x + 6, C.y + 2)
    const w = await walls(page)
    const last = w[w.length - 1]!
    const first = w[0]!
    expect(last.xEnd).toBeCloseTo(first.xStart, 6)
    expect(last.yEnd).toBeCloseTo(last.yStart, 6)
  })

  test('free angle: x of one vertex and y of another snap to the crossing', async ({ page }) => {
    const b = await box(page)
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    // A is up-left, B right of it and lower, C directly below B. From C the
    // direction to (A.x, B.y) is ~36 degrees: outside every angle-lock capture.
    const A = { x: cx - 100, y: cy - 150 }
    const B = { x: cx + 70, y: cy - 20 }
    const C = { x: cx + 70, y: cy + 105 }
    for (const p of [A, B, C]) {
      await page.mouse.move(p.x, p.y, { steps: 5 })
      await page.mouse.click(p.x, p.y)
    }
    await page.mouse.move(A.x + 40, B.y + 40, { steps: 6 })
    await page.mouse.move(A.x + 4, B.y + 3, { steps: 6 })
    await page.screenshot({ path: `${SHOTS}/2-intersection.png` })
    await page.mouse.click(A.x + 4, B.y + 3)
    const w = await walls(page)
    const last = w[w.length - 1]!
    expect(last.xEnd).toBeCloseTo(w[0]!.xStart, 6)
    expect(last.yEnd).toBeCloseTo(w[1]!.yStart, 6)
  })

  test('Alt disables the guides: the end stays on the raw cursor', async ({ page }) => {
    const { A, C } = await drawC(page)
    await page.keyboard.down('Alt')
    await page.mouse.move(A.x + 40, C.y + 2, { steps: 4 })
    await page.mouse.move(A.x + 6, C.y + 2, { steps: 4 })
    await page.screenshot({ path: `${SHOTS}/3-alt-off.png` })
    await page.mouse.click(A.x + 6, C.y + 2)
    await page.keyboard.up('Alt')
    const w = await walls(page)
    const last = w[w.length - 1]!
    expect(Math.abs(last.xEnd - w[0]!.xStart)).toBeGreaterThan(1)
  })

  test('not sticky: moving 25 px away leaves the guide', async ({ page }) => {
    const { A, C } = await drawC(page)
    await page.mouse.move(A.x + 6, C.y + 2, { steps: 6 })
    await page.mouse.move(A.x + 25, C.y + 2, { steps: 6 })
    await page.screenshot({ path: `${SHOTS}/4-released.png` })
    await page.mouse.click(A.x + 25, C.y + 2)
    const w = await walls(page)
    const last = w[w.length - 1]!
    expect(Math.abs(last.xEnd - w[0]!.xStart)).toBeGreaterThan(5)
  })
})
