import { test, expect, type Page } from '@playwright/test'

// Gaps: oversize pieces via 3D catalog placement and 3D drag/gizmo, and paste/duplicate of
// pieces that no longer fit. Each must show the toast and leave state + undo stack untouched.

const homeState = (page: Page) =>
  page.evaluate(() => {
    const store = (window as any).__model.getStore()
    const home = store.getHome()
    return {
      furniture: home.furniture.map((f: any) => ({ id: f.id, x: f.x, y: f.y, angleDeg: f.angleDeg, width: f.width, depth: f.depth })),
      canUndo: store.canUndo(),
      canRedo: store.canRedo(),
    }
  })

async function addRoom(page: Page, left: number, top: number, right: number, bottom: number, name: string) {
  await page.evaluate(({ left, top, right, bottom, name }) => {
    const model = (window as any).__model
    const pts: Array<[number, number]> = [[left, top], [right, top], [right, bottom], [left, bottom]]
    pts.forEach(([xs, ys], i) => {
      const [xe, ye] = pts[(i + 1) % 4]!
      model.addWall({ xStart: xs, yStart: ys, xEnd: xe, yEnd: ye, thickness: 10 })
    })
    model.addRoom(pts, { name })
  }, { left, top, right, bottom, name })
}

/** Aim the 3D camera straight down-ish at a plan point. */
async function aim(page: Page, x: number, y: number) {
  await page.evaluate(({ x, y }) => {
    const v = (window as any).__view3d
    v.camera.position.set(x, 1100, y + 600)
    v.controls.target.set(x, 0, y)
    v.controls.update()
  }, { x, y })
  await page.waitForTimeout(300)
}

/** Screen position of a plan point (x,y) at height h cm. */
const screenOf = (page: Page, x: number, y: number, h = 0) =>
  page.evaluate(({ x, y, h }) => {
    const v = (window as any).__view3d
    const p = v.camera.position.clone().set(x, h, y)
    p.project(v.camera)
    const rect = v.renderer.domElement.getBoundingClientRect()
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
  }, { x, y, h })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  await page.waitForSelector('.catalog-card', { timeout: 10_000 })
})

test('3D catalog placement of a piece too large for the room toasts and places nothing', async ({ page }) => {
  await addRoom(page, -20, -20, 20, 20, 'Closet')
  await aim(page, 0, 0)
  const before = await homeState(page)
  await page.locator('.catalog-card').first().click()
  await expect(page.locator('.catalog-status')).toContainText('Placing:')
  const at = await screenOf(page, 0, 0)
  await page.mouse.click(at.x, at.y)
  await expect(page.locator('.toast-error')).toContainText('is too large for room "Closet"')
  expect(await homeState(page)).toEqual(before)
})

test('3D body drag towards a room too small for the piece deflects it out; it never ends inside', async ({ page }) => {
  // The drag applies the same anti-clip snap as the plan, so a piece dragged at a closet it cannot
  // fit is held outside the closet's walls (no error needed). Only edits that bypass the snap
  // (the gizmo, below) can reach the too-large rejection.
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await addRoom(page, -500, -100, -100, 100, 'Hall')
  await addRoom(page, 100, -30, 400, 30, 'Closet')
  const id = await page.evaluate(() =>
    (window as any).__model.addFurniture({ name: 'Crate', x: -300, y: 0, angleDeg: 0, width: 100, depth: 100, height: 100, elevation: 0 }).id as string)
  await aim(page, -25, 0)
  const from = await screenOf(page, -300, 0, 50)
  const to = await screenOf(page, 250, 0, 50)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 1 })
  await page.mouse.up()
  const crate = (await homeState(page)).furniture.find((f) => f.id === id)!
  expect(crate.x + crate.width / 2, 'right edge stays out of the closet west wall (x=95)').toBeLessThanOrEqual(95 + 1e-6)
  expect(crate.x).not.toBe(-300)
  expect(errors).toEqual([])
})

test('3D gizmo drag into a room too small toasts and moves nothing', async ({ page }) => {
  await addRoom(page, -500, -100, -100, 100, 'Hall')
  await addRoom(page, 100, -30, 400, 30, 'Closet')
  await page.evaluate(() => {
    const model = (window as any).__model
    const f = model.addFurniture({ name: 'Crate', x: -300, y: 0, angleDeg: 0, width: 100, depth: 100, height: 100, elevation: 0 })
    model.setSelection([f.id])
  })
  await aim(page, -25, 0)
  const before = await homeState(page)
  // Midpoint of the x-axis arrow handle, projected to the screen.
  const handle = await page.evaluate(() => {
    const v = (window as any).__view3d
    v.camera.updateMatrixWorld()
    let hit: any = null
    v.gizmo.traverse((o: any) => { if (o.userData.gizmoKind === 'x' && o.geometry && !hit) hit = o })
    const p = hit.getWorldPosition(hit.position.clone())
    p.project(v.camera)
    const rect = v.renderer.domElement.getBoundingClientRect()
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
  })
  const to = await screenOf(page, 250, 0, 0)
  await page.mouse.move(handle.x, handle.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 1 })
  await page.mouse.up()
  await expect(page.locator('.toast-error')).toContainText('is too large for room "Closet"')
  const after = await homeState(page)
  expect(after.furniture).toEqual(before.furniture)
  expect(after.canRedo).toBe(false)
})

test.describe('paste and duplicate of a piece that no longer fits', () => {
  // A legacy home (loads verbatim): a 300x300 sofa in a 100x100 closet.
  async function loadLegacyOversize(page: Page) {
    await page.evaluate(() => {
      const store = (window as any).__model.getStore()
      const home = structuredClone(store.getHome())
      const w = (id: string, xs: number, ys: number, xe: number, ye: number) => ({ id, xStart: xs, yStart: ys, xEnd: xe, yEnd: ye, thickness: 10, levelRef: null })
      home.walls = [w('a', -50, -50, 50, -50), w('b', 50, -50, 50, 50), w('c', 50, 50, -50, 50), w('d', -50, 50, -50, -50)]
      home.rooms = [{ id: 'r', name: 'Closet', points: [[-50, -50], [50, -50], [50, 50], [-50, 50]], levelRef: null }]
      home.furniture = [{ id: 'sofa', name: 'Sofa', x: 0, y: 0, angleDeg: 0, width: 300, depth: 300, height: 80, elevation: 0 }]
      home.selection = ['sofa']
      store.loadHome(home)
    })
  }

  for (const [label, key] of [['paste', 'Control+v'], ['duplicate', 'Control+d']] as const) {
    test(`${label} toasts and leaves no partial state`, async ({ page }) => {
      await loadLegacyOversize(page)
      await page.locator('#plan-panel').click({ position: { x: 5, y: 5 } }).catch(() => {})
      await page.evaluate(() => (window as any).__model.setSelection(['sofa']))
      await page.keyboard.press('Control+c')
      const before = await homeState(page)
      await page.keyboard.press(key)
      await expect(page.locator('.toast-error')).toContainText('is too large for room "Closet"')
      expect(await homeState(page)).toEqual(before)
    })
  }
})
