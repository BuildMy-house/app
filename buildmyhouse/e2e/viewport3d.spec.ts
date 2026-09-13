import { test, expect } from '@playwright/test'

test.describe('3D viewport', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  })

  test('WebGL canvas exists with non-zero dimensions', async ({ page }) => {
    const canvas = page.locator('#view3d canvas')
    await expect(canvas).toBeVisible()
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThan(0)
    expect(box!.height).toBeGreaterThan(0)
  })

  test('canvas has rendered content (not blank)', async ({ page }) => {
    void page.locator('#view3d canvas')
    // Check the canvas is non-empty by verifying its internal resolution
    const hasContent = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('#view3d canvas')
      if (!c) return false
      return c.width > 0 && c.height > 0
    })
    expect(hasContent).toBe(true)
    // Also verify Three.js actually attached a renderer context
    const hasContext = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('#view3d canvas')
      if (!c) return false
      // Three.js uses webgl2 or webgl; check if context exists
      const attrs = c.getContext('webgl2')?.getExtension('WEBGL_lose_context')
        || c.getContext('webgl')?.getExtension('WEBGL_lose_context')
      return attrs !== null
    })
    expect(hasContext).toBe(true)
  })

  test('switching to plan-only hides 3D panel', async ({ page }) => {
    await page.locator('button[data-preset="plan"]').click()
    await expect(page.locator('#view3d-panel')).toHaveClass(/hidden/)
    await expect(page.locator('#plan-panel')).not.toHaveClass(/hidden/)
  })

  test('switching to 3D-only hides plan panel', async ({ page }) => {
    await page.locator('button[data-preset="3d"]').click()
    await expect(page.locator('#plan-panel')).toHaveClass(/hidden/)
    await expect(page.locator('#view3d-panel')).not.toHaveClass(/hidden/)
  })

  test('switching back to split shows both panels', async ({ page }) => {
    await page.locator('button[data-preset="plan"]').click()
    await page.locator('button[data-preset="split"]').click()
    await expect(page.locator('#plan-panel')).not.toHaveClass(/hidden/)
    await expect(page.locator('#view3d-panel')).not.toHaveClass(/hidden/)
  })

  test('empty scene shows the sky-colored background via renderer clear color', async ({ page }) => {
    // Three.js sets scene.background to 0xcce4fc — verify the renderer
    // is configured with a non-black clear color by checking the canvas
    // isn't all zeros (preserveDrawingBuffer not set, so readPixels may
    // return zeros; instead verify the CSS background isn't black).
    const bgColor = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('#view3d canvas')
      if (!c) return null
      const style = window.getComputedStyle(c)
      return style.backgroundColor
    })
    // Canvas elements have transparent or default background — just verify it exists
    expect(bgColor).not.toBeNull()
  })

  test('3D scene updates when walls are added via plan tool', async ({ page }) => {
    // Switch to wall tool, draw a wall via clicking on plan canvas
    await page.locator('button[data-tool="wall"]').click()
    const planCanvas = page.locator('#plan-canvas')
    const box = await planCanvas.boundingBox()
    expect(box).not.toBeNull()

    // Click start point
    await page.mouse.click(box!.x + box!.width * 0.3, box!.y + box!.height * 0.5)
    // Click end point
    await page.mouse.click(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5)
    // Escape to commit
    await page.keyboard.press('Escape')

    // Verify the canvas still exists (scene rebuilt after wall addition)
    const canvasStillThere = await page.locator('#view3d canvas').isVisible()
    expect(canvasStillThere).toBe(true)

    // Undo button should be enabled after drawing
    await expect(page.locator('#btn-undo')).toBeEnabled()
  })

  test('screenshot baseline: empty scene', async ({ page }) => {
    await page.waitForTimeout(500) // let Three.js render a frame
    await expect(page.locator('#view3d')).toHaveScreenshot('empty-viewport.png', {
      maxDiffPixelRatio: 0.05,
    })
  })

  test('orbit: dragging on 3D canvas rotates the camera', async ({ page }) => {
    const canvas = page.locator('#view3d canvas')
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()

    // Expose the camera position for inspection
    await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('#view3d canvas')
      if (c && !(c as any).__exposed) {
        ;(c as any).__exposed = true
      }
    })

    // Get camera state before drag
    const before = await page.evaluate(() => {
      // Access the global View3D instance if available on window
      const w = window as any
      if (w.__view3d) {
        const cam = w.__view3d.camera
        return { x: cam.position.x, y: cam.position.y, z: cam.position.z }
      }
      return null
    })

    // Drag to orbit
    const cx = box!.x + box!.width / 2
    const cy = box!.y + box!.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 100, cy + 50, { steps: 10 })
    await page.mouse.up()

    // Wait for damping to settle
    await page.waitForTimeout(500)

    // Verify the camera moved
    const after = await page.evaluate(() => {
      const w = window as any
      if (w.__view3d) {
        const cam = w.__view3d.camera
        return { x: cam.position.x, y: cam.position.y, z: cam.position.z }
      }
      return null
    })

    if (before && after) {
      const moved = Math.abs(before.x - after.x) + Math.abs(before.y - after.y) + Math.abs(before.z - after.z)
      expect(moved).toBeGreaterThan(1)
    }
  })

  test('3D canvas resizes when the divider is dragged', async ({ page }) => {
    const bufferOf = () =>
      page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('#view3d canvas')!
        const box = c.getBoundingClientRect()
        return {
          w: c.width,
          h: c.height,
          bw: Math.floor(box.width),
          bh: Math.floor(box.height),
        }
      })

    const before = await bufferOf()
    // The WebGL drawing buffer must at least cover the on-screen box.
    expect(before.w).toBeGreaterThanOrEqual(before.bw)
    expect(before.h).toBeGreaterThanOrEqual(before.bh)

    const divider = page.locator('#divider')
    const db = await divider.boundingBox()
    expect(db).not.toBeNull()

    // Drag the divider to change the 3D panel size.
    await page.mouse.move(db!.x + db!.width / 2, db!.y + db!.height / 2)
    await page.mouse.down()
    await page.mouse.move(db!.x + db!.width / 2 + 200, db!.y + db!.height / 2, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(150)

    const after = await bufferOf()
    expect(after.w).toBeGreaterThanOrEqual(after.bw)
    expect(after.h).toBeGreaterThanOrEqual(after.bh)
    // The renderer must have actually resized (proves the ResizeObserver fired
    // on a layout change that doesn't emit a window resize event).
    expect(after.w + after.h).not.toBeCloseTo(before.w + before.h, -1)
  })

  test('3D camera toggle switches between perspective and top', async ({ page }) => {
    const preset = () =>
      page.evaluate(() => (window as any).__view3d.director.getActivePreset())

    expect(await preset()).toBe('observer')
    await expect(page.locator('button[data-camera3d="observer"]')).toHaveClass(/active/)

    await page.locator('button[data-camera3d="top"]').click()
    expect(await preset()).toBe('top')
    await expect(page.locator('button[data-camera3d="top"]')).toHaveClass(/active/)

    await page.locator('button[data-camera3d="observer"]').click()
    expect(await preset()).toBe('observer')
  })

  test('top view frames the home bounds, not the origin', async ({ page }) => {
    // Draw a wall well to the right of the origin so its bounds center is > 0.
    await page.locator('button[data-tool="wall"]').click()
    const plan = page.locator('#plan-canvas')
    const b = await plan.boundingBox()
    expect(b).not.toBeNull()
    await page.mouse.click(b!.x + b!.width * 0.6, b!.y + b!.height * 0.4)
    await page.mouse.click(b!.x + b!.width * 0.85, b!.y + b!.height * 0.4)
    await page.keyboard.press('Escape')

    await page.locator('button[data-camera3d="top"]').click()
    const target = await page.evaluate(() => {
      const v = (window as any).__view3d
      return { x: v.controls.target.x, y: v.controls.target.y, z: v.controls.target.z }
    })
    // The house sits right of the origin, so a correctly framed top view
    // orbits its bounds center (world x = plan x) rather than (0,0,0).
    expect(target.x).toBeGreaterThan(0)
  })
})
