import { test, expect } from '@playwright/test'

test.describe('Fit frames 3D content far from world origin (QA repro)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  })

  test('Fit moves the orbit target onto walls drawn off-origin', async ({ page }) => {
    // Rectangle of walls centred on (-1500, -3000) cm — mirrors the QA report
    // of a room drawn around x:-158, y:-308 m. Added through HomeModel so the
    // store-change → 3D rebuild path is the same as UI drawing.
    const ids: string[] = await page.evaluate(() => {
      const model = (window as any).__model
      const walls = [
        { xStart: -1600, yStart: -3100, xEnd: -1400, yEnd: -3100 },
        { xStart: -1400, yStart: -3100, xEnd: -1400, yEnd: -2900 },
        { xStart: -1400, yStart: -2900, xEnd: -1600, yEnd: -2900 },
        { xStart: -1600, yStart: -2900, xEnd: -1600, yEnd: -3100 },
      ]
      return walls.map((w) => model.addWall({ ...w, thickness: 10, height: 250 }).id)
    })
    expect(ids).toHaveLength(4)
    await page.waitForTimeout(300)

    // Put the camera into the buggy pre-fix state: parked at the origin preset
    // area, pointing at the world origin, with the content out of frame.
    await page.evaluate(() => {
      const v = (window as any).__view3d
      v.camera.position.set(50, 170, 50)
      v.controls.target.set(0, 0, 0)
      v.controls.update()
      v.render()
    })
    await page.waitForTimeout(150)

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

    // The orbit target must land on the wall rectangle (centroid -1500, -3000
    // in world x/z), not stay near the origin where the preset pointed.
    expect(Math.hypot(after.target.x + 1500, after.target.z + 3000)).toBeLessThan(400)
    expect(Math.hypot(after.target.x, after.target.z)).toBeGreaterThan(1000)
    // Camera position stays in sync with the stored preset state (model path).
    expect(Math.abs(after.pos.x - after.preset.x)).toBeLessThan(1)
    expect(Math.abs(after.pos.z - after.preset.z)).toBeLessThan(1)
  })
})
