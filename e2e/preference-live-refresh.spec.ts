import { test, expect } from '@playwright/test'

/**
 * MAT-T10C: a preference-only edit (default wall material, ground color)
 * goes through HomeStore.patchNonUndoable(), which the 3D view's store
 * observer (view3d/watch.ts observeStore()) deliberately does not hook
 * generically -- see that file's comment. Before this fix, the 3D view kept
 * showing stale materials until some unrelated structural edit (or a full
 * reload) happened to trigger a rebuild. These tests confirm the fix's
 * explicit signal (notifyScenePreferenceChange()/onScenePreferenceChange()
 * for wall materials; a direct view3d.rebuild() call for ground color) makes
 * the 3D view refresh immediately, with NO other action in between.
 */
test.describe('preference-only edits live-refresh the 3D view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  })

  const openPrefs = async (page: import('@playwright/test').Page) => {
    await page.locator('.menu-trigger').nth(1).click()
    const entry = page.locator('.menu-item.open .menu-entry', { hasText: 'Preferences…' })
    await expect(entry).toBeVisible()
    await entry.click()
    await expect(page.locator('.prefs-dialog')).toBeVisible()
  }

  test('changing the default exterior wall material updates wall meshes immediately', async ({ page }) => {
    // Draw a single freestanding wall (no rooms -> both sides classify as
    // exterior, per wall-exterior.ts deriveWallSideExterior()).
    await page.locator('button[data-tool="wall"]').click()
    const planCanvas = page.locator('#plan-canvas')
    const box = await planCanvas.boundingBox()
    expect(box).not.toBeNull()
    const y = box!.y + box!.height * 0.5
    await page.mouse.click(box!.x + box!.width * 0.3, y)
    await page.mouse.click(box!.x + box!.width * 0.7, y)
    await page.keyboard.press('Escape')
    await page.locator('button[data-tool="selection"]').click()

    // Baseline: default exterior texture is 'plaster-white' (roughness 0.9,
    // set synchronously in scene.ts applyPbrMaps() -- no network image load
    // needed for this scalar, unlike material.map).
    const baselineRoughness: number = await page.evaluate(() => {
      const home = (window as any).__model.getStore().getHome()
      const wallId = home.walls[0].id
      const scene = (window as any).__view3d.scene
      const mesh = scene.getObjectByName(`wall:${wallId}`)
      const rightMaterial = Array.isArray(mesh.material) ? mesh.material[2] : mesh.material
      return rightMaterial.roughness
    })
    expect(baselineRoughness).toBeCloseTo(0.9, 5)

    // Open Preferences, switch Default Exterior Wall Material to Tile Floor
    // (roughness 0.35 -- deterministic, distinct from both the 0.9 plaster
    // default and the 0.7 untextured cladding baseline), and confirm.
    await openPrefs(page)
    const dialog = page.locator('.prefs-dialog')
    await dialog.locator('#mat-exterior-wall-texture').selectOption('tile-floor')
    await dialog.locator('.prefs-ok').click()
    await expect(dialog).not.toBeVisible()

    // No other edit happens in between -- confirm the 3D mesh already
    // reflects the new default, with zero additional action.
    const updatedRoughness: number = await page.evaluate(() => {
      const home = (window as any).__model.getStore().getHome()
      const wallId = home.walls[0].id
      const scene = (window as any).__view3d.scene
      const mesh = scene.getObjectByName(`wall:${wallId}`)
      const rightMaterial = Array.isArray(mesh.material) ? mesh.material[2] : mesh.material
      return rightMaterial.roughness
    })
    expect(updatedRoughness).toBeCloseTo(0.35, 5)
  })

  test('changing the ground color via Preferences updates the 3D scene immediately', async ({ page }) => {
    // Ground color is NOT material.color -- an untextured ground bakes a
    // per-vertex color-noise attribute from the base color (scene.ts
    // applyGroundVariation(), ticket 5d's grass/snow look). Read the first
    // vertex's baked color instead.
    const readGroundColor = () =>
      page.evaluate(() => {
        const scene = (window as any).__view3d.scene
        const ground = scene.getObjectByName('ground')
        const colorAttr = ground?.geometry.getAttribute('color')
        if (!colorAttr) return null
        return [colorAttr.getX(0), colorAttr.getY(0), colorAttr.getZ(0)]
      })

    const baselineColor = await readGroundColor()
    expect(baselineColor).not.toBeNull()

    await openPrefs(page)
    const dialog = page.locator('.prefs-dialog')
    await dialog.locator('#prefs-ground-color').evaluate((el: HTMLInputElement) => {
      el.value = '#ff00ff'
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await dialog.locator('.prefs-ok').click()
    await expect(dialog).not.toBeVisible()

    // No other edit happens in between -- confirm the ground mesh already
    // reflects the new color, with zero additional action.
    const updatedColor = await readGroundColor()
    expect(updatedColor).not.toBeNull()
    expect(updatedColor).not.toEqual(baselineColor)
    // Per-vertex noise perturbs the baked color slightly (GROUND_VARIATION_STRENGTH),
    // so compare loosely against pure magenta (1, 0, 1) rather than exact equality.
    expect(updatedColor![0]).toBeGreaterThan(0.8)
    expect(updatedColor![1]).toBeLessThan(0.2)
    expect(updatedColor![2]).toBeGreaterThan(0.8)
  })
})
