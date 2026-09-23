import { test, expect } from '@playwright/test'

/**
 * Regression for "the roof still seems to be always present" and its
 * follow-up "the roof is on when it should be off": interior view must
 * never render roofs, regardless of which level a roof is attached to
 * (originally fixed for single-story homes in 011cf96; the "interstitial
 * roof underside" exemption for lower-level roofs was removed after the
 * multi-story user report 2026-09-23). Outside view shows all roofs.
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

  test('roof on a lower level of a multi-story home stays hidden in interior view', async ({ page }) => {
    await boot(page)
    await page.evaluate(() => {
      const model = (window as unknown as { __model: any }).__model
      model.addLevel({ name: 'Ground', elevation: 0, floorThickness: 5, height: 250, visible: true, viewable: true })
      const ground = model.getStore().getHome().levels[0]
      model.addLevel({ name: 'Upper', elevation: 250, floorThickness: 5, height: 250, visible: true, viewable: true })
      // Roof attached to the GROUND level — the user's production shape
      // (roof drawn before the upper story was added).
      model.addRoof([[0, 0], [400, 0], [400, 200], [0, 200]], { levelRef: ground.id })
    })
    await page.waitForTimeout(200)

    expect(await roofMeshCount(page)).toBe(0)

    const outsideBtn = page.locator('button[data-outside-view="true"]')
    if (await outsideBtn.count()) {
      await outsideBtn.click()
      await page.waitForTimeout(200)
      expect(await roofMeshCount(page)).toBeGreaterThan(0)
    }
  })
})
