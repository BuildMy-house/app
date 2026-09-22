import { test, expect } from '@playwright/test'

/**
 * Regression for "the roof still seems to be always present": buildScene's
 * roof-hiding condition (added in ba4cc89) only fired when a specific level
 * was selected (activeLevel !== null). But every home's default state is
 * activeLevel === null ("All levels") — the state a single-story home stays
 * in forever since there is nothing to switch — so the roof never actually
 * hid for the common case. Fixed in scene.ts by keying the "is there a
 * level above" check off the roof's own levelRef instead of activeLevel.
 */

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.waitForSelector('#view3d canvas', { timeout: 30_000 })
  await page.waitForFunction(() => (window as unknown as { __model?: unknown }).__model, {
    timeout: 30_000,
  })
}

function roofMeshCount(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const v3d = (window as unknown as { __view3d?: { scene: { traverse: (fn: (o: any) => void) => void } } }).__view3d
    let count = 0
    v3d?.scene.traverse((obj: any) => {
      if (obj?.isMesh && typeof obj.name === 'string' && obj.name.startsWith('roof:')) count++
    })
    return count
  })
}

test.describe('roof visibility in default (interior) app state', () => {
  test('roof is hidden by default on a fresh single-story home (no level selected, not outside view)', async ({ page }) => {
    await boot(page)
    await page.evaluate(() => {
      const model = (window as unknown as { __model: any }).__model
      model.addRoof([[0, 0], [400, 0], [400, 200], [0, 200]], {})
    })
    await page.waitForTimeout(200)

    // Default state: no level explicitly selected, and outside-view toggle
    // (if present) not engaged -- this is exactly the state every new home
    // loads into.
    expect(await roofMeshCount(page)).toBe(0)

    // Switching to outside view should still show it -- roof isn't gone,
    // just correctly hidden for the interior default.
    const outsideBtn = page.locator('button[data-outside-view="true"]')
    if (await outsideBtn.count()) {
      await outsideBtn.click()
      await page.waitForTimeout(200)
      expect(await roofMeshCount(page)).toBeGreaterThan(0)
    }
  })
})
