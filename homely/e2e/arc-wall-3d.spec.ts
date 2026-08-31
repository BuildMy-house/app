import { test, expect } from '@playwright/test'

test.describe('arc wall 3D extrusion (M53b)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#plan-canvas')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  })

  test('bulging a wall extrudes a curved 3D wall, not a flat straight box', async ({ page }) => {
    const canvas = page.locator('#plan-canvas')
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()

    // Draw a horizontal wall left → right at mid-height.
    const y = box!.y + box!.height * 0.5
    const x0 = box!.x + box!.width * 0.3
    const x1 = box!.x + box!.width * 0.7
    await page.locator('button[data-tool="wall"]').click()
    await page.mouse.click(x0, y)
    await page.mouse.click(x1, y)
    await page.keyboard.press('Escape')

    // Select the wall and capture the straight 3D wall vertex count.
    await page.locator('button[data-tool="selection"]').click()
    const midX = box!.x + box!.width * 0.5
    await page.mouse.click(midX, y)

    const wallVertexCount = () =>
      page.evaluate(() => {
        let count = 0
        ;(window as any).__view3d.scene.traverse((o: any) => {
          if (o.name && o.name.startsWith('wall:') && o.geometry?.getAttribute('position')) {
            count += o.geometry.getAttribute('position').count
          }
        })
        return count
      })

    const straightVertices = await wallVertexCount()

    // Drag the midpoint arc handle perpendicular to the wall to bulge it.
    await page.mouse.move(midX, y)
    await page.mouse.down()
    await page.mouse.move(midX, y - 70, { steps: 10 })
    await page.mouse.up()

    // Wait for the scene to rebuild from the arcExtent change.
    await page.waitForTimeout(300)

    const arcExtent = await page.evaluate(() => {
      const w = (window as any).__model.getStore().getHome().walls[0]
      return w ? w.arcExtent : null
    })
    expect(typeof arcExtent).toBe('number')
    expect(Math.abs(arcExtent!)).toBeGreaterThan(0.1)

    // A curved extrusion has far more vertices than a straight box.
    const arcVertices = await wallVertexCount()
    expect(arcVertices).toBeGreaterThan(straightVertices * 2)

    // Screenshot proof: the 3D view shows a visibly curved wall extrusion.
    await page.locator('#view3d canvas').screenshot({ path: 'test-results/m53b-curved-wall-3d.png' })
  })
})
