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

function namedMeshCount(page: import('@playwright/test').Page, prefix: string) {
  return page.evaluate((p) => {
    const v3d = (window as unknown as { __view3d?: { scene: { traverse: (fn: (o: any) => void) => void } } }).__view3d
    let count = 0
    v3d?.scene.traverse((obj: any) => {
      if (obj?.isMesh && typeof obj.name === 'string' && obj.name.startsWith(p)) count++
    })
    return count
  }, prefix)
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

  test('single-level home: ceiling visibility rules hold and repeated toggles leave no stale meshes', async ({ page }) => {
    await boot(page)
    await page.evaluate(() => {
      const model = (window as unknown as { __model: any }).__model
      model.addLevel({ name: 'Ground', elevation: 0, floorThickness: 5, height: 250, visible: true, viewable: true })
      const ground = model.getStore().getHome().levels[0]
      // Auto ceiling (ceilingVisible undefined), forced-on, forced-off.
      model.addRoom([[0, 0], [200, 0], [200, 200], [0, 200]], { levelRef: ground.id })
      model.addRoom([[200, 0], [400, 0], [400, 200], [200, 200]], { levelRef: ground.id, ceilingVisible: true })
      model.addRoom([[0, 200], [200, 200], [200, 400], [0, 400]], { levelRef: ground.id, ceilingVisible: false })
      model.addRoof([[0, 0], [400, 0], [400, 400], [0, 400]], { levelRef: ground.id })
    })
    await page.waitForFunction(() => {
      const model = (window as unknown as { __model?: any }).__model
      const home = model?.getStore()?.getHome()
      return home?.levels?.length === 1 && home?.rooms?.length === 3 && home?.roofs?.length === 1
    }, { timeout: 10_000 })
    await page.waitForTimeout(200)

    const assertInsideState = async () => {
      // Default state (no level selected): roofs never render in interior view.
      expect(await roofMeshCount(page)).toBe(0)
      // Auto ceiling hidden; forced-on shown exactly once (no duplicates); forced-off hidden.
      expect(await namedMeshCount(page, 'ceiling:')).toBe(1)
    }
    const assertOutsideState = async () => {
      // Outside view: the roof renders exactly once, forced-off ceiling stays hidden.
      expect(await roofMeshCount(page)).toBe(1)
      expect(await namedMeshCount(page, 'ceiling:')).toBe(2)
    }

    // Static toolbar HTML: both toggle buttons must exist or the toggles below are vacuous.
    await expect(page.locator('button[data-outside-view="true"]')).toHaveCount(1)
    await expect(page.locator('button[data-outside-view="false"]')).toHaveCount(1)

    const insideBtn = page.locator('button[data-outside-view="false"]')
    const outsideBtn = page.locator('button[data-outside-view="true"]')

    await assertInsideState()
    await outsideBtn.click()
    await page.waitForTimeout(200)
    await assertOutsideState()
    await insideBtn.click()
    await page.waitForTimeout(200)
    await assertInsideState()
    await outsideBtn.click()
    await page.waitForTimeout(200)
    await assertOutsideState()
  })
})
