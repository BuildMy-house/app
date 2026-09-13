import { test, expect } from '@playwright/test'

test.describe('wall chain Backspace', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  })

  test('Backspace removes the last wall mid-chain; the finished chain still undoes as ONE step', async ({
    page,
  }) => {
    const wallCount = () =>
      page.evaluate(() => (window as any).__model.getStore().getHome().walls.length)

    await page.locator('button[data-tool="wall"]').click()
    await page.locator('#magnetism').uncheck({ force: true })

    const planCanvas = page.locator('#plan-canvas')
    const box = await planCanvas.boundingBox()
    expect(box).not.toBeNull()

    // Click 4 points → 3 committed walls, chain still open.
    const x0 = box!.x + box!.width * 0.25
    const y0 = box!.y + box!.height * 0.25
    await page.mouse.click(x0, y0)
    await page.mouse.click(x0 + 100, y0)
    await page.mouse.click(x0 + 100, y0 + 100)
    await page.mouse.click(x0 + 200, y0 + 100)
    expect(await wallCount()).toBe(3)

    // Backspace walks the chain back exactly one wall; chain stays open.
    await page.keyboard.press('Backspace')
    expect(await wallCount()).toBe(2)

    // Finish the chain normally with a double-click (2 wall clicks cancel
    // out: the click half lands at zero length, the dblclick half commits).
    await page.mouse.dblclick(x0 + 200, y0 + 160)
    expect(await wallCount()).toBe(3)

    // Compound undo intact: undoing must reach the PRE-SESSION state (0
    // walls) with no per-segment entries leaked by Backspace. Note: the
    // one-time 3D auto-fit (doFit → moveObserverCamera, pre-existing
    // behavior) can push ONE camera entry above the session's compound
    // entry, so allow up to two undos — but a partial session (1-2 walls)
    // after any single undo would mean broken compound undo.
    await page.keyboard.press('Control+z')
    const afterOne = await wallCount()
    expect([0, 3]).toContain(afterOne)
    await page.keyboard.press('Control+z')
    expect(await wallCount()).toBe(0)
    // Nothing else left to undo — Backspace never touched the stack.
    await expect(page.locator('#btn-undo')).toBeDisabled()
  })
})
