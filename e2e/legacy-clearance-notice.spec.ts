import { test, expect, type Page } from '@playwright/test'

// A saved draft from before pieces were kept clear of walls: loads verbatim, so it
// overlaps. The app must say so and offer a one-click, one-undo-step fix.

async function bootWithLegacyDraft(page: Page, extraFurniture: object[] = []) {
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__model, null, { timeout: 10_000 })
  // Take the app's own empty home and add a 400x400 room plus an overlapping shelf.
  const draft = await page.evaluate((extra) => {
    const home = structuredClone((window as any).__model.getStore().getHome())
    const w = (id: string, xs: number, ys: number, xe: number, ye: number) => ({ id, xStart: xs, yStart: ys, xEnd: xe, yEnd: ye, thickness: 10, levelRef: null })
    home.walls = [w('w1', 0, 0, 400, 0), w('w2', 400, 0, 400, 400), w('w3', 400, 400, 0, 400), w('w4', 0, 400, 0, 0)]
    home.rooms = [{ id: 'r1', name: 'Den', points: [[5, 5], [395, 5], [395, 395], [5, 395]], levelRef: null }]
    home.furniture = [{ id: 'shelf', name: 'Shelf', x: 200, y: 0, angleDeg: 0, width: 120, depth: 60, height: 80, elevation: 0 }, ...extra]
    return JSON.stringify(home)
  }, extraFurniture)
  // Runs before the app's own scripts on the reload, after the old page's beforeunload autosave.
  await page.addInitScript((json) => localStorage.setItem('homely-local-draft', json), draft)
  await page.reload()
  await page.waitForFunction(() => (window as any).__model, null, { timeout: 10_000 })
}

const furnitureY = (page: Page, id: string) =>
  page.evaluate((id) => (window as any).__model.getStore().getHome().furniture.find((f: any) => f.id === id)?.y, id)

test('a legacy overlapping draft shows a notice; Fix overlaps is one undo step', async ({ page }) => {
  await bootWithLegacyDraft(page)
  const notice = page.locator('.toast-notice')
  await expect(notice).toContainText('1 furniture piece overlaps a wall')
  expect(await furnitureY(page, 'shelf')).toBe(0)

  await notice.getByRole('button', { name: 'Fix overlaps' }).click()
  await expect(page.locator('.toast-success')).toContainText('Moved 1 piece')
  expect(await furnitureY(page, 'shelf')).toBe(35)

  await page.evaluate(() => (window as any).__model.getStore().undo())
  expect(await furnitureY(page, 'shelf')).toBe(0)
})

test('Fix overlaps names pieces that cannot be fixed instead of throwing', async ({ page }) => {
  await bootWithLegacyDraft(page, [
    { id: 'huge', name: 'Huge Sofa', x: 200, y: 200, angleDeg: 0, width: 900, depth: 900, height: 80, elevation: 0 },
  ])
  await page.locator('.toast-notice').getByRole('button', { name: 'Fix overlaps' }).click()
  await expect(page.locator('.toast-error')).toContainText('Huge Sofa')
  expect(await furnitureY(page, 'shelf')).toBe(35)
  expect(await furnitureY(page, 'huge')).toBe(200)
})
