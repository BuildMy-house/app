import { test, expect } from '@playwright/test'

test.describe('furniture placement', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
    // Catalog loads async from a manifest; wait for the add (card) buttons.
    await page.waitForSelector('.catalog-card', { timeout: 10_000 })
  })

  test('arming a catalog piece shows the placing status', async ({ page }) => {
    await page.locator('.catalog-card').first().click()
    await expect(page.locator('.catalog-status')).toContainText('Placing:')
  })

  test('clicking the plan places furniture (count increases)', async ({ page }) => {
    const before = await page.evaluate(() => (window as any).__model.getStore().getHome().furniture.length)
    await page.locator('.catalog-card').first().click()
    const box = await page.locator('#plan-canvas').boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.55)
    const after = await page.evaluate(() => (window as any).__model.getStore().getHome().furniture.length)
    expect(after).toBe(before + 1)
  })

  test('clicking the 3D view places furniture (add in 3D)', async ({ page }) => {
    // Switch to 3D-only: the plan canvas is hidden, placement must work here.
    await page.locator('button[data-preset="3d"]').click()
    await expect(page.locator('#plan-panel')).toHaveClass(/hidden/)

    const before = await page.evaluate(() => (window as any).__model.getStore().getHome().furniture.length)
    await page.locator('.catalog-card').first().click()
    const v3 = await page.locator('#view3d canvas').boundingBox()
    expect(v3).not.toBeNull()
    // A plain click (no drag) on the floor places the armed piece.
    await page.mouse.click(v3!.x + v3!.width * 0.5, v3!.y + v3!.height * 0.7)
    const after = await page.evaluate(() => (window as any).__model.getStore().getHome().furniture.length)
    expect(after).toBe(before + 1)
  })

  test('catalog auto-disarms after one placement (M13)', async ({ page }) => {
    const before = await page.evaluate(() => (window as any).__model.getStore().getHome().furniture.length)
    await page.locator('.catalog-card').first().click()
    const box = await page.locator('#plan-canvas').boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.55)
    // After placement the catalog should auto-disarm — status returns to default.
    await expect(page.locator('.catalog-status')).toContainText('Click a piece to place it')
    const after = await page.evaluate(() => (window as any).__model.getStore().getHome().furniture.length)
    expect(after).toBe(before + 1)
  })

  test('switching tools disarms catalog (M13)', async ({ page }) => {
    await page.locator('.catalog-card').first().click()
    await expect(page.locator('.catalog-status')).toContainText('Placing:')
    // Switch to Select tool — catalog must disarm.
    await page.locator('button[data-tool="selection"]').click()
    await expect(page.locator('.catalog-status')).toContainText('Click a piece to place it')
  })

  test('place one item, then select it without creating duplicate (M13)', async ({ page }) => {
    // Arm and place one furniture item.
    // Use a full-size furniture item; the curated catalog also contains
    // wall frames whose tiny footprint makes a plan hit-test ambiguous.
    // MAT-T9: the grid is virtualized — "Bar table" sits deep in the list
    // and may be outside the mounted window. Searching filters the full
    // item list so the card gets mounted (same pattern as catalog-panel.spec.ts).
    await page.locator('.catalog-search').fill('Bar table')
    await page.locator('.catalog-card').filter({ hasText: 'Bar table' }).click()
    const box = await page.locator('#plan-canvas').boundingBox()
    expect(box).not.toBeNull()
    const cx = box!.x + box!.width * 0.5
    const cy = box!.y + box!.height * 0.55
    await page.mouse.click(cx, cy)

    // Furniture count should be exactly 1.
    const countAfterPlace = await page.evaluate(() => (window as any).__model.getStore().getHome().furniture.length)
    expect(countAfterPlace).toBe(1)

    // Catalog should have auto-disarmed; switch to selection just in case.
    await page.locator('button[data-tool="selection"]').click()

    // Click the same spot — this must NOT create a second item.
    await page.mouse.click(cx, cy)
    const countAfterClick = await page.evaluate(() => (window as any).__model.getStore().getHome().furniture.length)
    expect(countAfterClick).toBe(1)

    // The placed item should be selectable — verify its id is in the selection.
    const selectedCount = await page.evaluate(() => (window as any).__model.getStore().getHome().selection.length)
    expect(selectedCount).toBe(1)
  })

  test('can place two different items sequentially (M13)', async ({ page }) => {
    const before = await page.evaluate(() => (window as any).__model.getStore().getHome().furniture.length)
    const box = await page.locator('#plan-canvas').boundingBox()
    expect(box).not.toBeNull()

    // Place first item.
    await page.locator('.catalog-card').first().click()
    await page.mouse.click(box!.x + box!.width * 0.3, box!.y + box!.height * 0.5)

    // Place second item (different catalog card).
    await page.locator('.catalog-card').nth(1).click()
    await page.mouse.click(box!.x + box!.width * 0.7, box!.y + box!.height * 0.5)

    const after = await page.evaluate(() => (window as any).__model.getStore().getHome().furniture.length)
    expect(after).toBe(before + 2)
  })

  test('placement with magnetism near a wall snaps the angle', async ({ page }) => {
    // Draw a horizontal wall in the plan.
    await page.locator('button[data-tool="wall"]').click()
    const plan = await page.locator('#plan-canvas').boundingBox()
    expect(plan).not.toBeNull()
    const y = plan!.y + plan!.height * 0.5
    await page.mouse.click(plan!.x + plan!.width * 0.3, y)
    await page.mouse.click(plan!.x + plan!.width * 0.7, y)
    await page.keyboard.press('Escape')
    await page.locator('button[data-tool="selection"]').click()

    // Ensure magnetism is on, then place a piece just above the wall line.
    await page.locator('#magnetism').check({ force: true })
    await page.locator('.catalog-card').first().click()
    // Click near the wall but slightly off it — within the snap threshold.
    await page.mouse.click(plan!.x + plan!.width * 0.5, plan!.y + plan!.height * 0.5 - 8)

    const snapped = await page.evaluate(() => {
      const f = (window as any).__model.getStore().getHome().furniture
      return f.length > 0 ? { angle: f[f.length - 1].angleDeg } : null
    })
    expect(snapped).not.toBeNull()
    // A horizontal wall magnetizes the angle toward 0°.
    expect(Math.abs(snapped!.angle)).toBeLessThan(1)
  })

  test('dragging furniture in 3D pushes it clear of the wall it straddles', async ({ page }) => {
    await page.locator('button[data-preset="3d"]').click()
    await expect(page.locator('#plan-panel')).toHaveClass(/hidden/)
    // Let any preset camera framing settle before pinning our own camera.
    await page.waitForTimeout(500)

    const ids = await page.evaluate(() => {
      const app = window as any
      const model = app.__model
      const wall = model.addWall({
        xStart: 0, yStart: 0, xEnd: 800, yEnd: 0, thickness: 10, height: 100, levelRef: null,
      })
      // A 100x40 piece centred ON the wall line starts clipping through it.
      const f = model.addFurniture({
        name: 'Dragged', x: 400, y: 0, angleDeg: 0,
        width: 100, depth: 40, height: 300, elevation: 0, levelRef: null,
      })
      // Pre-select: the drag's own setSelection would otherwise recenter the
      // camera mid-drag and shift the screen→floor mapping under our feet.
      model.setSelection([f.id])
      return { id: f.id, wallId: wall.id }
    })
    // The first geometry in an empty home re-frames the camera from a
    // deferred store callback — pinning before it lands gets overridden.
    await page.waitForTimeout(400)

    const setup = await page.evaluate(() => {
      const app = window as any
      const view = app.__view3d
      const cam = view.camera
      cam.position.set(400, 500, 600)
      if (view.controls) {
        view.controls.target.set(400, 0, 0)
        view.controls.update()
      }
      cam.updateMatrixWorld(true)
      cam.matrixWorldInverse.copy(cam.matrixWorld).invert()
      view.render()

      const rect = (document.querySelector('#view3d canvas') as HTMLCanvasElement).getBoundingClientRect()
      const mulMV = (m: number[], x: number, y: number, z: number, w: number) => [
        m[0] * x + m[4] * y + m[8] * z + m[12] * w,
        m[1] * x + m[5] * y + m[9] * z + m[13] * w,
        m[2] * x + m[6] * y + m[10] * z + m[14] * w,
        m[3] * x + m[7] * y + m[11] * z + m[15] * w,
      ]
      const project = (x: number, y: number, z: number) => {
        const v = mulMV(cam.matrixWorldInverse.elements, x, y, z, 1)
        const c = mulMV(cam.projectionMatrix.elements, v[0], v[1], v[2], v[3])
        return {
          x: rect.left + ((c[0] / c[3] + 1) / 2) * rect.width,
          y: rect.top + ((1 - c[1] / c[3]) / 2) * rect.height,
        }
      }
      const unprojectFloor = (sx: number, sy: number) => {
        const nx = ((sx - rect.left) / rect.width) * 2 - 1
        const ny = -((sy - rect.top) / rect.height) * 2 + 1
        const c = mulMV(cam.projectionMatrixInverse.elements, nx, ny, 0.5, 1)
        const v = mulMV(cam.matrixWorld.elements, c[0] / c[3], c[1] / c[3], c[2] / c[3], 1)
        const o = cam.position
        const t = -o.y / (v[1] - o.y)
        return { x: o.x + t * (v[0] - o.x), y: o.z + t * (v[2] - o.z) }
      }

      // Front face, high up: above the 100 cm wall (so the furniture is the
      // first raycast hit) and clear of the selection gizmo (arrows 90 cm,
      // ring radius 65 cm).
      const start = project(400, 260, 20)
      const floorStart = unprojectFloor(start.x, start.y)
      // End 40 cm along +x on the same floor line → naive (440, 0), still
      // straddling the 800 cm wall, so a no-ant-clip drag would leave it inside.
      const end = project(floorStart.x + 40, 0, floorStart.y)
      // The gizmo must not swallow the pointerdown.
      if (view.gizmo) view.gizmo.visible = false
      return { start, end }
    })

    // Sanity: the piece genuinely clips through the wall before the drag.
    const before = await page.evaluate((id) => {
      const f = (window as any).__model.getStore().getHome().furniture.find((x: any) => x.id === id)
      return { x: f.x, y: f.y }
    }, ids.id)
    expect(Math.abs(before.y)).toBeLessThan(20)

    await page.mouse.move(setup.start.x, setup.start.y)
    await page.mouse.down()
    // Prove the pointerdown started a real 3D furniture drag (raycast hit),
    // not a placement click, and that the camera didn't drift away from the
    // pin the screen projections were computed against.
    const during = await page.evaluate((id) => ({
      selected: (window as any).__model.getStore().getHome().selection.includes(id),
      dragging: !!(window as any).__view3d.furnitureDrag,
      camPos: (window as any).__view3d.camera.position.toArray().map((v: number) => Math.round(v)),
    }), ids.id)
    expect(during.selected).toBe(true)
    expect(during.dragging).toBe(true)
    expect(during.camPos).toEqual([400, 500, 600])
    await page.mouse.move(setup.end.x, setup.end.y, { steps: 10 })
    await page.mouse.up()

    const after = await page.evaluate(({ id, wallId }: { id: string; wallId: string }) => {
      const home = (window as any).__model.getStore().getHome()
      const f = home.furniture.find((x: any) => x.id === id)
      const wall = home.walls.find((w: any) => w.id === wallId)
      // Axis-aligned footprint (angle 0) vs the wall slab.
      const half = wall.thickness / 2
      const overlapX = f.x + f.width / 2 > Math.min(wall.xStart, wall.xEnd)
        && f.x - f.width / 2 < Math.max(wall.xStart, wall.xEnd)
      const overlapY = Math.abs(f.y - (wall.yStart + wall.yEnd) / 2) < f.depth / 2 + half
      return {
        x: f.x, y: f.y, overlap: overlapX && overlapY,
        dragActive: !!(window as any).__view3d.furnitureDrag,
      }
    }, { id: ids.id, wallId: ids.wallId })

    expect(after.dragActive).toBe(false)
    expect(Math.abs(after.x - 400)).toBeGreaterThan(5)
    expect(after.overlap).toBe(false)
    // Flush against the wall: depth/2 (20) + wall half-thickness (5).
    expect(Math.abs(Math.abs(after.y) - 25)).toBeLessThan(1)
    // ...and still adjacent, not flung across the room.
    expect(Math.abs(after.y)).toBeLessThan(100)
  })
})
