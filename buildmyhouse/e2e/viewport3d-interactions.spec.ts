import { test, expect } from '@playwright/test'

/**
 * 3D viewport interaction contract. Agents MUST keep this green after any
 * change to homely/src/view3d/* — it is the executable spec for:
 *   - OrbitControls drag/zoom redraws without recursion
 *   - selecting an object recenters the camera target on it (plan or 3D click)
 * Run: `npm run e2e`  (or `npx playwright test viewport3d-interactions`)
 */

test.describe('3D viewport interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
    await page.waitForFunction(() => (window as any).__view3d?.controls, null, { timeout: 10_000 })
    await page.waitForFunction(() => (window as any).__model, null, { timeout: 10_000 })
  })

  test('orbit drag moves the camera and does not recurse', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    const before = await page.evaluate(() => {
      const c = (window as any).__view3d.camera
      return { x: c.position.x, y: c.position.y, z: c.position.z }
    })

    const box = await page.locator('#view3d canvas').boundingBox()
    if (!box) throw new Error('no canvas box')
    const cx = box.x + box.width / 2
    const cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 120, cy + 60, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(600)

    const after = await page.evaluate(() => {
      const c = (window as any).__view3d.camera
      return { x: c.position.x, y: c.position.y, z: c.position.z }
    })
    const moved =
      Math.abs(after.x - before.x) + Math.abs(after.y - before.y) + Math.abs(after.z - before.z)

    expect(moved, 'camera should move on drag').toBeGreaterThan(0.01)
    expect(errors.some((e) => /recursion/i.test(e)), 'no recursion').toBe(false)
  })

  test('selecting furniture recenters the camera target (plan selection)', async ({ page }) => {
    const result = await page.evaluate(() => {
      const model = (window as any).__model
      const item = model.addFurniture({
        name: 'Test', catalogId: 'x', x: 5000, y: 3000, angleDeg: 0,
        width: 100, depth: 100, height: 200, elevation: 0, color: null, doorOrWindow: false,
      })
      model.setSelection([item.id])
      return { id: item.id, x: item.x, y: item.y, h: item.height }
    })
    await page.waitForTimeout(400)

    const { target, selection } = await page.evaluate(() => {
      const v = (window as any).__view3d
      return {
        target: { x: v.controls.target.x, y: v.controls.target.y, z: v.controls.target.z },
        selection: (window as any).__model.store.getHome().selection,
      }
    })
    expect(selection).toContain(result.id)
    expect(Math.abs(target.x - result.x)).toBeLessThan(1)
    expect(Math.abs(target.y - result.h / 2)).toBeLessThan(1)
    expect(Math.abs(target.z - result.y)).toBeLessThan(1)
  })

  test('clicking furniture in the 3D view selects and centers it', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    const id = await page.evaluate(() => {
      const model = (window as any).__model
      const item = model.addFurniture({
        name: 'Pick', catalogId: 'x', x: 0, y: 0, angleDeg: 0,
        width: 200, depth: 200, height: 200, elevation: 0, color: null, doorOrWindow: false,
      })
      // Aim the viewport at the object's center so a center click raycasts it.
      const v = (window as any).__view3d
      v.controls.target.set(0, 100, 0)
      v.controls.update()
      return item.id
    })
    await page.waitForTimeout(200)

    const box = await page.locator('#view3d canvas').boundingBox()
    if (!box) throw new Error('no canvas box')
    // A small drag would orbit; a near-stationary click selects.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(400)

    const { target, selection } = await page.evaluate(() => {
      const v = (window as any).__view3d
      return {
        target: { x: v.controls.target.x, y: v.controls.target.y, z: v.controls.target.z },
        selection: (window as any).__model.store.getHome().selection,
      }
    })
    expect(selection, '3D click should select the furniture').toContain(id)
    expect(Math.abs(target.x)).toBeLessThan(1)
    expect(Math.abs(target.y - 100)).toBeLessThan(1)
    expect(Math.abs(target.z)).toBeLessThan(1)
    expect(errors.some((e) => /recursion/i.test(e)), 'no recursion').toBe(false)
  })
})
