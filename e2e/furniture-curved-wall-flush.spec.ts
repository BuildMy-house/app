import { test, expect } from '@playwright/test'
import { measurePlan } from './helpers/plan-mapping'

const centre = { x: 0, y: 0 }

test('a piece dragged into a curved wall rests flush against its true arc', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  // Half-circle wall of radius 80 cm about the canvas centre, bulging upward
  // (SH3D: sagitta = chord/2 * tan(extent/4)), 10 cm thick: band r in [75, 85].
  const RADIUS = 80
  const THICKNESS = 10
  const TOLERANCE_CM = 0.005
  const outer = RADIUS + THICKNESS / 2
  const id = await page.evaluate(({ centre, RADIUS, THICKNESS }) => {
    const model = (window as any).__model
    model.addWall({
      xStart: centre.x - RADIUS, yStart: centre.y, xEnd: centre.x + RADIUS, yEnd: centre.y,
      thickness: THICKNESS, arcExtent: Math.PI,
    })
    const f = model.addFurniture({
      name: 'Crate', x: centre.x + 30, y: centre.y - 140, angleDeg: 20, width: 30, depth: 30, height: 40, elevation: 0,
    })
    model.setSelection([f.id])
    return f.id as string
  }, { centre, RADIUS, THICKNESS })

  const { toScreen } = await measurePlan(page)
  const from = toScreen(centre.x + 30, centre.y - 140)
  const to = toScreen(centre.x + 30, centre.y - 90) // pointer ends in the outer half of the band
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()

  const gap = await page.evaluate(({ id, centre, outer }) => {
    const f = (window as any).__model.getStore().getHome().furniture.find((item: any) => item.id === id)
    const rad = (f.angleDeg * Math.PI) / 180
    const ux = Math.cos(rad), uy = Math.sin(rad)
    // Closest point of the oriented rectangle to the arc centre.
    const dx = centre.x - f.x, dy = centre.y - f.y
    const lx = Math.max(-f.width / 2, Math.min(f.width / 2, dx * ux + dy * uy))
    const ly = Math.max(-f.depth / 2, Math.min(f.depth / 2, -dx * uy + dy * ux))
    const px = f.x + ux * lx - uy * ly
    const py = f.y + uy * lx + ux * ly
    return Math.hypot(px - centre.x, py - centre.y) - outer
  }, { id, centre, outer })

  // Never cuts into the true outer face, and stands off it by no more than the arc tolerance.
  expect(gap).toBeGreaterThanOrEqual(-1e-6)
  expect(gap).toBeLessThanOrEqual(TOLERANCE_CM + 1e-6)
})
