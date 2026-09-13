import { test, expect, type Page } from '@playwright/test'

/**
 * Wall-loop closure under real mouse imprecision.
 *
 * Regression guards for two findings:
 * - A.1: endpoint snap margins were fixed world units, so zooming out shrank
 *   the on-screen click target below a real mouse's precision. The snap
 *   radius is now zoom-aware (~10 screen px, clamped).
 * - A.2: the closure preview/tooltip was only fed by the automation
 *   `move_mouse` command; real pointer moves never reached the engine, and
 *   the preview simulated the RAW cursor instead of the snapped point, so it
 *   effectively never fired interactively.
 */

test.describe('wall loop closing precision', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  })

  /** Zoom out ~2x (6 wheel steps x 0.9) with the cursor parked on the plan canvas. */
  async function zoomOut(page: Page, box: { x: number; y: number; width: number; height: number }) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 120)
    }
  }

  async function setupWallTool(page: Page) {
    await page.locator('button[data-tool="wall"]').click()
    // Deterministic resolution: endpoint snap (the thing under test) only.
    await page.locator('#magnetism').uncheck({ force: true })
    await page.locator('#grid-snap').uncheck({ force: true })
  }

  async function roomCount(page: Page): Promise<number> {
    return page.evaluate(() => (window as any).__model.getStore().getHome().rooms.length)
  }

  test('closing click several px off the origin still snaps and creates a room when zoomed out', async ({ page }) => {
    await setupWallTool(page)
    const planCanvas = page.locator('#plan-canvas')
    const box = (await planCanvas.boundingBox())!
    expect(box).not.toBeNull()
    await zoomOut(page, box)

    // Rectangle corners (screen coords before drawing; the view is frozen
    // from here on because userHasZoomed disables auto-refit).
    const ax = box.x + box.width * 0.4
    const ay = box.y + box.height * 0.4
    const bx = box.x + box.width * 0.6
    const by = box.y + box.height * 0.4
    const cx = box.x + box.width * 0.6
    const cy = box.y + box.height * 0.6
    const dx = box.x + box.width * 0.4
    const dy = box.y + box.height * 0.6

    await page.mouse.click(ax, ay)
    await page.mouse.click(bx, by)
    await page.mouse.click(cx, cy)
    await page.mouse.click(dx, dy)

    // Imprecise closing click: ~6 px right of the true origin. At the
    // zoomed-out scale the old fixed 4-world-unit margin was ~2 screen px
    // and this click missed; the zoom-aware margin (~10 px) must catch it.
    await page.mouse.dblclick(ax + 6, ay)

    const dialog = page.locator('.auto-floor-dialog')
    await expect(dialog).toBeVisible()
    await dialog.locator('.auto-floor-confirm').click()
    expect(await roomCount(page)).toBe(1)
  })

  test('closing click far from the origin does not close the loop', async ({ page }) => {
    await setupWallTool(page)
    const planCanvas = page.locator('#plan-canvas')
    const box = (await planCanvas.boundingBox())!
    await zoomOut(page, box)

    const ax = box.x + box.width * 0.4
    const ay = box.y + box.height * 0.4
    await page.mouse.click(ax, ay)
    await page.mouse.click(box.x + box.width * 0.6, ay)
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6)
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.6)

    // ~30 px off: beyond the zoom-aware snap radius — must NOT close.
    await page.mouse.dblclick(ax + 30, ay)

    await expect(page.locator('.auto-floor-dialog')).toBeHidden()
    expect(await roomCount(page)).toBe(0)
    await page.keyboard.press('Escape')
  })

  test('snap-lock indicator rings the origin while the cursor hovers near it', async ({ page }) => {
    await setupWallTool(page)
    const planCanvas = page.locator('#plan-canvas')
    const box = (await planCanvas.boundingBox())!
    await zoomOut(page, box)

    const ax = box.x + box.width * 0.4
    const ay = box.y + box.height * 0.4
    await page.mouse.click(ax, ay)
    await page.mouse.click(box.x + box.width * 0.6, ay)
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6)
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.6)

    // Scan a small box of plan-canvas pixels for the green closure color
    // (CLOSURE_PREVIEW_STROKE over white composites near rgb(132,189,132)).
    const scanForGreen = (cx: number, cy: number) =>
      page.evaluate(({ cx, cy }) => {
        const canvas = document.querySelector('#plan-canvas') as HTMLCanvasElement
        const rect = canvas.getBoundingClientRect()
        const sx = ((cx - rect.left) * canvas.width) / rect.width
        const sy = ((cy - rect.top) * canvas.height) / rect.height
        const ctx = canvas.getContext('2d')
        if (!ctx) return false
        const r = 20
        const img = ctx.getImageData(sx - r, sy - r, r * 2, r * 2)
        for (let i = 0; i < img.data.length; i += 4) {
          const red = img.data[i]!
          const green = img.data[i + 1]!
          const blue = img.data[i + 2]!
          if (green - Math.max(red, blue) > 20) return true
        }
        return false
      }, { cx, cy })

    // Cursor still at the last corner (far from origin): no green there.
    expect(await scanForGreen(ax, ay)).toBe(false)

    // Hover ~5 px off the origin: snap-lock ring + closure preview appear.
    await page.mouse.move(ax + 5, ay)
    await page.waitForTimeout(150)
    expect(await scanForGreen(ax, ay)).toBe(true)
    await page.keyboard.press('Escape')
  })
})
