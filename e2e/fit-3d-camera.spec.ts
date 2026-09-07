import { test, expect } from '@playwright/test'

test.describe('Fit reframes the 3D camera (M44)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  })

  async function drawUShape(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('#magnetism').uncheck({ force: true })
    await page.locator('button[data-tool="wall"]').click()
    const plan = page.locator('#plan-canvas')
    const box = await plan.boundingBox()
    expect(box).not.toBeNull()
    const x0 = box!.x + box!.width * 0.3
    const x1 = box!.x + box!.width * 0.7
    const y0 = box!.y + box!.height * 0.3
    const y1 = box!.y + box!.height * 0.7
    await page.mouse.click(x0, y0)
    await page.mouse.click(x1, y0)
    await page.mouse.click(x1, y1)
    await page.mouse.click(x0, y1)
    await page.keyboard.press('Escape')
    await expect(page.locator('#btn-undo')).toBeEnabled()
  }

  test('Fit button re-frames a detached 3D camera onto drawn content', async ({ page }) => {
    await drawUShape(page)

    // Deliberately fling the 3D camera (position + orbit target) into empty space
    // so the scene visibly loses the drawn content before Fit is clicked.
    await page.evaluate(() => {
      const v = (window as any).__view3d
      v.camera.position.set(2500, 1200, -2500)
      v.controls.target.set(2000, 0, -2000)
      v.controls.update()
      v.render()
    })
    await page.waitForTimeout(150)

    const before = await page.evaluate(() => {
      const v = (window as any).__view3d
      return { x: v.camera.position.x, y: v.camera.position.y, z: v.camera.position.z, t: v.controls.target }
    })

    await page.locator('#view3d').screenshot({ path: 'test-results/m44-fit-before.png' })

    await page.locator('#btn-fit').click()
    await page.waitForTimeout(150)

    const after = await page.evaluate(() => {
      const v = (window as any).__view3d
      const preset = v.director.getCamera()
      return {
        pos: { x: v.camera.position.x, y: v.camera.position.y, z: v.camera.position.z },
        target: { x: v.controls.target.x, y: v.controls.target.y, z: v.controls.target.z },
        preset: { x: preset.x, y: preset.z, z: preset.y },
      }
    })
    await page.locator('#view3d').screenshot({ path: 'test-results/m44-fit-after.png' })

    // The camera must be restored to the active preset's stored position ...
    expect(Math.abs(after.pos.x - after.preset.x)).toBeLessThan(1)
    expect(Math.abs(after.pos.z - after.preset.z)).toBeLessThan(1)
    // ...and the orbit target must move from empty space back onto the drawn
    // U-shape (which sits near the model origin), not stay where it was flung.
    expect(Math.hypot(after.target.x, after.target.z)).toBeLessThan(800)
    expect(
      Math.hypot(before.t.x - after.target.x, before.t.z - after.target.z),
    ).toBeGreaterThan(500)
  })
})