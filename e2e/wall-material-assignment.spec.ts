import { test, expect } from '@playwright/test'

// Live verification for T12: a wall-side texture selected through the actual
// properties-panel dropdown (a) is present in the list regardless of the
// wall's auto-derived exterior/interior classification, (b) visibly applies
// to the 3D mesh's material, and (c) persists through undo/redo.
test.describe('wall material assignment (T12)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  })

  test('selecting a wallUsage-mismatched texture (carpet, on a freestanding/exterior-classified wall) applies and persists', async ({
    page,
  }) => {
    const wallId = await page.evaluate(() => {
      const model = (window as any).__model
      const wall = model.addWall({ xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15 })
      model.setSelection([wall.id])
      return wall.id
    })

    const row = page
      .locator('.prop-row')
      .filter({ has: page.locator('.prop-label', { hasText: 'L Texture' }) })
    const select = row.locator('select')
    await expect(select).toBeVisible()

    // Regression: carpet is interior-only (wallUsage), yet a freestanding
    // wall with no enclosing room is classified exterior -- before the T12
    // fix this option did not exist in the dropdown at all.
    const values = await select.locator('option').evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value),
    )
    expect(values).toContain('carpet')

    await select.selectOption('carpet')

    const committed = await page.evaluate(
      (id) => (window as any).__model.getStore().getHome().walls.find((w: any) => w.id === id)
        .leftSideTextureId,
      wallId,
    )
    expect(committed).toBe('carpet')

    // Visible render: the wall mesh's left-side material actually carries a
    // texture map once the async load settles.
    await expect
      .poll(
        async () =>
          page.evaluate((id) => {
            const scene = (window as any).__view3d.scene
            const mesh = scene.getObjectByName(`wall:${id}`)
            const mats = mesh?.material
            const left = Array.isArray(mats) ? mats[1] : mats
            return Boolean(left?.map)
          }, wallId),
        { timeout: 10_000 },
      )
      .toBe(true)

    // Persists across undo/redo (not just the initial commit).
    await page.keyboard.press('Control+z')
    const afterUndo = await page.evaluate(
      (id) => (window as any).__model.getStore().getHome().walls.find((w: any) => w.id === id)
        ?.leftSideTextureId ?? null,
      wallId,
    )
    expect(afterUndo).toBeNull()

    await page.keyboard.press('Control+y')
    const afterRedo = await page.evaluate(
      (id) => (window as any).__model.getStore().getHome().walls.find((w: any) => w.id === id)
        .leftSideTextureId,
      wallId,
    )
    expect(afterRedo).toBe('carpet')
  })
})
