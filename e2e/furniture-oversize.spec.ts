import { test, expect, type Page } from '@playwright/test'
import { measurePlan } from './helpers/plan-mapping'

const CENTER = { x: 0, y: 0 }

async function addRoom(page: Page, left: number, top: number, right: number, bottom: number, name: string) {
  await page.evaluate(
    ({ left, top, right, bottom, name }) => {
      const model = (window as any).__model
      const pts: Array<[number, number]> = [[left, top], [right, top], [right, bottom], [left, bottom]]
      pts.forEach(([xs, ys], i) => {
        const [xe, ye] = pts[(i + 1) % 4]!
        model.addWall({ xStart: xs, yStart: ys, xEnd: xe, yEnd: ye, thickness: 10 })
      })
      model.addRoom(pts, { name })
    },
    { left, top, right, bottom, name },
  )
}

const homeState = (page: Page) =>
  page.evaluate(() => {
    const store = (window as any).__model.getStore()
    const home = store.getHome()
    return {
      furniture: home.furniture.map((f: any) => ({ id: f.id, x: f.x, y: f.y, angleDeg: f.angleDeg, width: f.width, depth: f.depth })),
      canUndo: store.canUndo(),
    }
  })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  await page.waitForSelector('.catalog-card', { timeout: 10_000 })
})

test('rotating a piece until it no longer fits its room shows the error toast and keeps the last valid angle', async ({ page }) => {
  // Corridor with a 190 x 70 cm interior: a 150 x 40 piece fits flat, not turned upright.
  await addRoom(page, -100, -40, 100, 40, 'Corridor')
  const id = await page.evaluate(({ x, y }) => {
    const model = (window as any).__model
    const f = model.addFurniture({ name: 'Bench', x, y, angleDeg: 0, width: 150, depth: 40, height: 50, elevation: 0 })
    model.setSelection([f.id])
    return f.id as string
  }, CENTER)

  const { toScreen, pxPerCm } = await measurePlan(page)
  const { x: cx, y: cy } = toScreen(CENTER.x, CENTER.y)
  const ringPx = 80
  const knob = { x: cx, y: cy - (20 * pxPerCm + 22) }
  const atAngle = (deg: number) => ({ x: cx + ringPx * Math.sin((deg * Math.PI) / 180), y: cy - ringPx * Math.cos((deg * Math.PI) / 180) })
  await page.mouse.move(knob.x, knob.y)
  await page.mouse.down()
  await page.mouse.move(atAngle(30).x, atAngle(30).y, { steps: 5 })
  await page.mouse.move(atAngle(90).x, atAngle(90).y, { steps: 10 })
  await page.mouse.up()

  const toast = page.locator('.toast-error')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('"Bench" (150 x 40 cm) is too large for room "Corridor"')
  await expect(toast).toContainText('Try rotating it, or pick a smaller piece.')

  const { furniture } = await homeState(page)
  const bench = furniture.find((f: any) => f.id === id)!
  // Last accepted angle: the footprint at that angle still fits the 70 cm corridor height.
  const rad = (Math.abs(bench.angleDeg) * Math.PI) / 180
  const heightAtAngle = 150 * Math.abs(Math.sin(rad)) + 40 * Math.abs(Math.cos(rad))
  expect(heightAtAngle).toBeLessThanOrEqual(70 + 1e-6)
  expect(Math.abs(bench.angleDeg)).toBeLessThan(90)
})

test('placing a catalog piece in a room too small for it shows the error toast and places nothing', async ({ page }) => {
  await addRoom(page, -20, -20, 20, 20, 'Closet')
  const { toScreen } = await measurePlan(page)
  const { x: cx, y: cy } = toScreen(CENTER.x, CENTER.y)
  const before = await homeState(page)

  await page.locator('.catalog-card').first().click()
  await expect(page.locator('.catalog-status')).toContainText('Placing:')
  await page.mouse.click(cx, cy)

  const toast = page.locator('.toast-error')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('is too large for room "Closet"')
  const after = await homeState(page)
  expect(after.furniture).toEqual(before.furniture)
  expect(after.canUndo).toBe(before.canUndo)
  // Rejected placement leaves the catalog armed so another spot can be tried.
  await expect(page.locator('.catalog-status')).toContainText('Placing:')
})
