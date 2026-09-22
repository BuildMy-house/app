import { test, expect } from '@playwright/test'

// Discoverability regression guard for the floor/level selector: the group
// lived unlabelled mid-scroll in a single overflowing toolbar row, so users
// couldn't find it. It now has a "Floor:" label and a bordered, tinted
// container, and must be reachable without horizontal toolbar scrolling at
// standard desktop viewports.

const SCREENSHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? '/tmp/opencode'

async function addLevelViaUi(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.locator('#btn-add-level').click()
  const input = page.locator('.prefs-overlay .dialog-input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill(name)
  await page.locator('.prefs-overlay .dialog-confirm').click()
  await expect(input).not.toBeVisible()
}

/** Assert an element is fully inside the viewport (not clipped by toolbar overflow). */
async function expectWithinViewport(page: import('@playwright/test').Page, selector: string): Promise<void> {
  const box = await page.locator(selector).boundingBox()
  expect(box, `${selector} has a bounding box`).not.toBeNull()
  expect(box!.x, `${selector} left edge`).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width, `${selector} right edge`).toBeLessThanOrEqual(page.viewportSize()!.width)
}

test.describe('toolbar level selector discoverability', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
    await page.waitForFunction(() => (window as any).__model, null, { timeout: 10_000 })
  })

  test('Floor: label is visible, adjacent to, and ordered before the level group', async ({ page }) => {
    const label = page.locator('#level-group-label')
    await expect(label).toHaveText('Floor:')
    await expect(label).toBeVisible()

    const labelBox = await label.boundingBox()
    const groupBox = await page.locator('#level-group').boundingBox()
    expect(labelBox).not.toBeNull()
    expect(groupBox).not.toBeNull()
    // Toolbar is align-items:center: compare vertical centers, not box tops
    // (the label's line box is shorter than the group's border box).
    expect(labelBox!.y + labelBox!.height / 2, 'label vertically centered with group').toBeCloseTo(groupBox!.y + groupBox!.height / 2, 0)
    expect(labelBox!.x + labelBox!.width, 'label sits immediately left of the group').toBeLessThanOrEqual(groupBox!.x)
  })

  test('level group is fully visible at 1280px without horizontal toolbar scrolling', async ({ page }) => {
    await expectWithinViewport(page, '#level-group-label')
    await expectWithinViewport(page, '#level-group')
    await expectWithinViewport(page, '#btn-level-all')
    await expectWithinViewport(page, '#btn-add-level')
  })

  test('all level controls stay visible after adding a second level', async ({ page }) => {
    await addLevelViaUi(page, 'Ground Floor')
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().levels.length === 1)
    await addLevelViaUi(page, 'Level 2')
    await page.waitForFunction(() => (window as any).__model.getStore().getHome().levels.length === 2)

    for (const selector of [
      '#level-group-label',
      '#level-group',
      '#btn-level-all',
      'button.level-btn:has-text("Ground Floor")',
      'button.level-btn:has-text("Level 2")',
      '#btn-add-level',
    ]) {
      await expectWithinViewport(page, selector)
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/toolbar-level-discoverability.png`, fullPage: false })
  })
})
