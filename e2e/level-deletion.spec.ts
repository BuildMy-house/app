import { test, expect } from '@playwright/test'

// The app replaced native prompt()/confirm() with a custom promise-based
// overlay (src/ui/dialogs.ts) specifically so it could be driven from e2e --
// this spec was still written against page.on('dialog'), which only
// intercepts native dialogs and therefore never fired here at all (silent
// no-op, not a slow/flaky one). Drive the actual overlay instead.

async function addLevel(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.locator('#btn-add-level').click()
  const input = page.locator('.prefs-overlay .dialog-input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill(name)
  await page.locator('.prefs-overlay .dialog-confirm').click()
  await expect(input).not.toBeVisible()
}

async function confirmOverlay(page: import('@playwright/test').Page): Promise<void> {
  const overlay = page.locator('.prefs-overlay')
  await expect(overlay).toBeVisible({ timeout: 5000 })
  await overlay.locator('.dialog-confirm').click()
  await expect(overlay).not.toBeVisible()
}

async function cancelOverlay(page: import('@playwright/test').Page): Promise<void> {
  const overlay = page.locator('.prefs-overlay')
  await expect(overlay).toBeVisible({ timeout: 5000 })
  await overlay.locator('.dialog-cancel').click()
  await expect(overlay).not.toBeVisible()
}

test.describe('level deletion', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
    await page.waitForFunction(() => (window as any).__model, null, { timeout: 10_000 })
  })

  test('delete button appears on each level tab and is disabled for the last level', async ({ page }) => {
    // Initially there are 0 levels — no delete buttons
    await expect(page.locator('button.level-delete')).toHaveCount(0)

    // Add first level
    await addLevel(page, 'Ground Floor')
    await expect(page.locator('button.level-delete')).toHaveCount(1)
    await expect(page.locator('button.level-delete').first()).toBeDisabled()

    // Add second level
    await addLevel(page, 'Level 2')
    await expect(page.locator('button.level-delete')).toHaveCount(2)
    await expect(page.locator('button.level-delete').nth(0)).toBeEnabled()
    await expect(page.locator('button.level-delete').nth(1)).toBeEnabled()
  })

  test('deleting a level removes it and its scoped content, undo restores everything', async ({ page }) => {
    // Add two levels
    await addLevel(page, 'Ground Floor')
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().levels.length === 1)

    await addLevel(page, 'Level 2')
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().levels.length === 2)

    // Click on Level 2 tab to make it active
    const level2Btn = page.locator('button.level-btn', { hasText: 'Level 2' })
    await level2Btn.click()

    // Draw a wall on Level 2
    await page.locator('button[data-tool="wall"]').click()
    const planCanvas = page.locator('#plan-canvas')
    const box = await planCanvas.boundingBox()
    expect(box).not.toBeNull()
    const y = box!.y + box!.height * 0.5
    await page.mouse.click(box!.x + box!.width * 0.3, y)
    await page.mouse.click(box!.x + box!.width * 0.7, y)
    await page.keyboard.press('Escape')

    // Verify Level 2 exists and has a wall scoped to it
    const home1 = await page.evaluate(() => (window as any).__model.getStore().getHome())
    expect(home1.levels).toHaveLength(2)
    const level2Id = home1.levels[1].id
    const wallsOnL2 = home1.walls.filter((w: any) => w.levelRef === level2Id)
    expect(wallsOnL2.length).toBe(1)

    // Delete Level 2 via the × button — accept confirm
    const deleteBtn = page.locator(`button.level-delete[data-delete-level="${level2Id}"]`)
    await deleteBtn.click()
    await confirmOverlay(page)

    // Verify Level 2 and its wall are gone
    const home2 = await page.evaluate(() => (window as any).__model.getStore().getHome())
    expect(home2.levels).toHaveLength(1)
    expect(home2.levels[0].name).toBe('Ground Floor')
    const orphanWalls = home2.walls.filter((w: any) =>
      !home2.levels.some((l: any) => l.id === w.levelRef),
    )
    expect(orphanWalls).toHaveLength(0)

    // Undo — level and wall should both be restored
    await page.keyboard.press('Control+z')
    await page.waitForFunction(
      () => (window as any).__model.getStore().getHome().levels.length === 2,
    )
    const home3 = await page.evaluate(() => (window as any).__model.getStore().getHome())
    expect(home3.levels).toHaveLength(2)
    const restoredWallsOnL2 = home3.walls.filter((w: any) => w.levelRef === home3.levels[1].id)
    expect(restoredWallsOnL2.length).toBe(1)
  })

  test('canceling confirm does not delete the level', async ({ page }) => {
    // Add two levels
    await addLevel(page, 'Ground Floor')
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().levels.length === 1)

    await addLevel(page, 'Level 2')
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().levels.length === 2)

    // Try to delete Level 2 but cancel the confirm
    const level2Id = await page.evaluate(() => (window as any).__model.getStore().getHome().levels[1].id)
    const deleteBtn = page.locator(`button.level-delete[data-delete-level="${level2Id}"]`)
    await deleteBtn.click()
    await cancelOverlay(page)

    // Level 2 should still exist
    const home = await page.evaluate(() => (window as any).__model.getStore().getHome())
    expect(home.levels).toHaveLength(2)
  })
})
