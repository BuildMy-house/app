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
    await page.locator('.catalog-card').first().click()
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
})
