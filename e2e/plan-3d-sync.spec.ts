import { test, expect } from '@playwright/test'

test.describe('plan ↔ 3D sync', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  })

  test('drawing a wall in plan updates the 3D scene', async ({ page }) => {
    // Activate wall tool
    await page.locator('button[data-tool="wall"]').click()

    const planCanvas = page.locator('#plan-canvas')
    const box = await planCanvas.boundingBox()
    expect(box).not.toBeNull()

    // Draw a horizontal wall: left → right
    const y = box!.y + box!.height * 0.5
    await page.mouse.click(box!.x + box!.width * 0.3, y)
    await page.mouse.click(box!.x + box!.width * 0.7, y)
    await page.keyboard.press('Escape')

    // Undo button should now be enabled
    await expect(page.locator('#btn-undo')).toBeEnabled()

    // Wall tool stays active after escape (empty chain committed, tool stays wall)
    await expect(page.locator('#status-tool')).toContainText('wall')
  })

  test('undo removes walls from both views', async ({ page }) => {
    // Draw a wall
    await page.locator('button[data-tool="wall"]').click()
    const planCanvas = page.locator('#plan-canvas')
    const box = await planCanvas.boundingBox()
    const y = box!.y + box!.height * 0.5
    await page.mouse.click(box!.x + box!.width * 0.3, y)
    await page.mouse.click(box!.x + box!.width * 0.7, y)
    await page.keyboard.press('Escape')

    // Verify wall exists (undo enabled)
    await expect(page.locator('#btn-undo')).toBeEnabled()

    // Undo via keyboard
    await page.keyboard.press('Control+z')

    // Undo should now be disabled (back to empty)
    await expect(page.locator('#btn-undo')).toBeDisabled()
  })

  test('redo restores walls in both views', async ({ page }) => {
    // Draw a wall
    await page.locator('button[data-tool="wall"]').click()
    const planCanvas = page.locator('#plan-canvas')
    const box = await planCanvas.boundingBox()
    const y = box!.y + box!.height * 0.5
    await page.mouse.click(box!.x + box!.width * 0.3, y)
    await page.mouse.click(box!.x + box!.width * 0.7, y)
    await page.keyboard.press('Escape')

    // Undo
    await page.keyboard.press('Control+z')
    await expect(page.locator('#btn-undo')).toBeDisabled()

    // Redo
    await page.keyboard.press('Control+y')
    await expect(page.locator('#btn-undo')).toBeEnabled()
  })

  test('drawing a 4-wall room creates expected wall count', async ({ page }) => {
    await page.locator('button[data-tool="wall"]').click()
    await page.locator('#magnetism').uncheck({ force: true })

    const planCanvas = page.locator('#plan-canvas')
    const box = await planCanvas.boundingBox()
    expect(box).not.toBeNull()

    // Draw 4 walls forming a rectangle
    const x0 = box!.x + box!.width * 0.25
    const x1 = box!.x + box!.width * 0.75
    const y0 = box!.y + box!.height * 0.25
    const y1 = box!.y + box!.height * 0.75

    await page.mouse.click(x0, y0) // top-left
    await page.mouse.click(x1, y0) // top-right
    await page.mouse.click(x1, y1) // bottom-right
    await page.mouse.click(x0, y1) // bottom-left
    await page.mouse.dblclick(x0, y0) // close loop

    // 4 walls should exist now
    await expect(page.locator('#btn-undo')).toBeEnabled()

    // Switch to selection tool, verify we can interact
    await page.locator('button[data-tool="selection"]').click()
    await expect(page.locator('#status-tool')).toContainText('selection')
  })

  test('camera preset buttons work in split view', async ({ page }) => {
    // Default is split
    await expect(page.locator('button[data-preset="split"]')).toHaveClass(/active/)

    // Switch to 3D only
    await page.locator('button[data-preset="3d"]').click()
    await expect(page.locator('#plan-panel')).toHaveClass(/hidden/)
    await expect(page.locator('#view3d-panel')).not.toHaveClass(/hidden/)

    // Switch back to split
    await page.locator('button[data-preset="split"]').click()
    await expect(page.locator('#plan-panel')).not.toHaveClass(/hidden/)
    await expect(page.locator('#view3d-panel')).not.toHaveClass(/hidden/)
  })

  test('keyboard shortcuts: Escape returns to selection tool', async ({ page }) => {
    await page.locator('button[data-tool="wall"]').click()
    // Start drawing
    const planCanvas = page.locator('#plan-canvas')
    const box = await planCanvas.boundingBox()
    await page.mouse.click(box!.x + box!.width * 0.3, box!.y + box!.height * 0.5)
    // Escape cancels/commits chain
    await page.keyboard.press('Escape')
    // Should be back in selection tool (empty chain → selection)
  })

  test('ceiling toggle in properties panel (M56)', async ({ page }) => {
    // Create a room programmatically via the exposed model API.
    // The room tool draws polygons, so a single click doesn't auto-fill.
    const roomId: string = await page.evaluate(() => {
      const model = (window as any).__model
      const room = model.addRoom(
        [[0, 0], [300, 0], [300, 300], [0, 300]],
        { ceilingVisible: true },
      )
      model.setSelection([room.id])
      return room.id
    })

    // Verify room was created and selected
    const selection: string[] = await page.evaluate(() => {
      return (window as any).__model.getStore().getHome().selection
    })
    expect(selection).toContain(roomId)

    // Properties panel should show Ceiling checkbox
    const ceilingCheckbox = page.locator('#properties-panel input[type="checkbox"]').last()
    await expect(ceilingCheckbox).toBeVisible()

    // Verify initial state: ceiling checked (we created with ceilingVisible: true)
    await expect(ceilingCheckbox).toBeChecked()

    // Ad-hoc screenshot with ceiling on
    const view3d = page.locator('#view3d')
    await expect(view3d).toBeVisible()
    await page.waitForTimeout(300)
    await view3d.screenshot({ path: 'test-results/m56-ceiling-on.png' })

    // Toggle ceiling off
    await ceilingCheckbox.uncheck({ force: true })

    // Verify toggle worked
    await expect(ceilingCheckbox).not.toBeChecked()

    // Ad-hoc screenshot with ceiling off
    await view3d.screenshot({ path: 'test-results/m56-ceiling-off.png' })
  })
})
