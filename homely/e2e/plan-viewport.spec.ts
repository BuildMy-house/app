import { test, expect } from '@playwright/test'

test.describe('plan (canvas) viewport', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#plan-canvas')
  })

  test('scroll wheel zooms and stays within bounds', async ({ page }) => {
    const zoom = () => page.locator('#status-zoom').textContent()
    const before = await zoom()
    const canvas = page.locator('#plan-canvas')
    const b = await canvas.boundingBox()
    expect(b).not.toBeNull()

    await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2)
    await page.mouse.wheel(0, -300) // zoom in
    const zoomedIn = await zoom()
    expect(zoomedIn).not.toBe(before)
    expect(Number(zoomedIn!.replace(/\D/g, ''))).toBeGreaterThan(
      Number(before!.replace(/\D/g, '')),
    )

    await page.mouse.wheel(0, 600) // zoom back out
    const zoomedOut = await zoom()
    expect(Number(zoomedOut!.replace(/\D/g, ''))).toBeLessThan(
      Number(zoomedIn!.replace(/\D/g, '')),
    )
  })

  test('zoom keeps the model point under the cursor stable', async ({ page }) => {
    const canvas = page.locator('#plan-canvas')
    const b = await canvas.boundingBox()
    expect(b).not.toBeNull()
    const cx = b!.x + b!.width * 0.35
    const cy = b!.y + b!.height * 0.4

    await page.mouse.move(cx, cy)
    const before = await page.locator('#status-cursor').textContent()

    await page.mouse.wheel(0, -400) // zoom in around the cursor
    await page.mouse.move(cx, cy)
    const after = await page.locator('#status-cursor').textContent()

    // The same screen pixel should report the same model coordinate after a
    // cursor-centered zoom (the core invariant of zoom-to-cursor).
    expect(after).toBe(before)
  })

  test('middle-click drag pans the plan', async ({ page }) => {
    const canvas = page.locator('#plan-canvas')
    const b = await canvas.boundingBox()
    expect(b).not.toBeNull()
    const cx = b!.x + b!.width / 2
    const cy = b!.y + b!.height / 2

    await page.mouse.move(cx, cy)
    const before = await page.locator('#status-cursor').textContent()

    await page.mouse.down({ button: 'middle' })
    await page.mouse.move(cx - 60, cy - 40, { steps: 6 })
    await page.mouse.up({ button: 'middle' })

    await page.mouse.move(cx, cy)
    const after = await page.locator('#status-cursor').textContent()
    expect(after).not.toBe(before)
  })

  test('Fit button re-fits an empty plan to 100%', async ({ page }) => {
    const canvas = page.locator('#plan-canvas')
    const b = await canvas.boundingBox()
    await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2)
    await page.mouse.wheel(0, -400) // zoom in first
    await expect(page.locator('#status-zoom')).not.toHaveText('zoom: 100%')

    await page.locator('#btn-fit').click()
    await expect(page.locator('#status-zoom')).toHaveText('zoom: 100%')
  })

  test('dragging a wall midpoint handle bulges it into a curved wall (M53a)', async ({ page }) => {
    const canvas = page.locator('#plan-canvas')
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()

    // Draw a horizontal wall left → right at mid-height.
    const y = box!.y + box!.height * 0.5
    const x0 = box!.x + box!.width * 0.3
    const x1 = box!.x + box!.width * 0.7
    await page.locator('button[data-tool="wall"]').click()
    await page.mouse.click(x0, y)
    await page.mouse.click(x1, y)
    await page.keyboard.press('Escape')

    // Select the wall (click its midpoint).
    await page.locator('button[data-tool="selection"]').click()
    const midX = box!.x + box!.width * 0.5
    await page.mouse.click(midX, y)

    const arcBefore = await page.evaluate(() => {
      const w = (window as any).__model.getStore().getHome().walls[0]
      return w ? w.arcExtent : null
    })
    expect(arcBefore == null || arcBefore === 0).toBe(true)

    // Drag the midpoint handle perpendicular to the wall.
    await page.mouse.move(midX, y)
    await page.mouse.down()
    await page.mouse.move(midX, y - 70, { steps: 10 })
    await page.mouse.up()

    const arcExtent = await page.evaluate(() => {
      const w = (window as any).__model.getStore().getHome().walls[0]
      return w ? w.arcExtent : null
    })
    expect(typeof arcExtent).toBe('number')
    expect(Math.abs(arcExtent!)).toBeGreaterThan(0.1)

    // One undo step reverts the drag back to a straight wall.
    await page.keyboard.press('Control+z')
    const arcAfterUndo = await page.evaluate(() => {
      const w = (window as any).__model.getStore().getHome().walls[0]
      return w ? w.arcExtent : null
    })
    expect(arcAfterUndo == null || arcAfterUndo === 0).toBe(true)

    // Redo the bulge and capture a screenshot of the curved wall.
    await page.keyboard.press('Control+y')
    await page.waitForTimeout(200)
    await canvas.screenshot({ path: 'test-results/m53a-curved-wall.png' })
  })
})
