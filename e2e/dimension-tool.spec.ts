import { test, expect, type Page } from '@playwright/test'

// Real-browser walk through the dimension tool: hover indicators, the
// three-click flow (start, end, pull out the offset), one-click "dimension
// this wall", selecting, offset dragging and deleting. The unit tests drive
// the engine directly; this exists because the first pass of the tool passed
// all of them while the live preview never moved in a browser (the pointer
// handler never fed the cursor to the engine). Screenshots land in
// DIM_SHOTS (default: the test output dir) for visual review.

const SHOTS = process.env.DIM_SHOTS

type Cal = { sx: number; sy: number; ox: number; oy: number }

test.describe('dimension tool (real pointer)', () => {
  test.use({ viewport: { width: 1400, height: 900 } })

  let cal: Cal
  let box: { x: number; y: number; width: number; height: number }

  const dims = (page: Page) =>
    page.evaluate(() => (window as any).__model.getStore().getHome().dimensionLines as Array<Record<string, number>>)

  const cursorModel = async (page: Page) => {
    const t = (await page.locator('#status-cursor').textContent()) ?? ''
    const m = t.match(/x:\s*(-?[\d.]+)\s+y:\s*(-?[\d.]+)/)!
    return [parseFloat(m[1]!), parseFloat(m[2]!)] as const
  }

  /** Map model cm to screen px using the status bar's own cursor read-out. */
  const calibrate = async (page: Page) => {
    await page.mouse.move(box.x + 100, box.y + 100)
    await page.waitForTimeout(80)
    const a = await cursorModel(page)
    await page.mouse.move(box.x + 400, box.y + 600)
    await page.waitForTimeout(80)
    const c = await cursorModel(page)
    const sx = 300 / (c[0] - a[0])
    const sy = 500 / (c[1] - a[1])
    cal = { sx, sy, ox: box.x + 100 - a[0] * sx, oy: box.y + 100 - a[1] * sy }
  }
  const S = (x: number, y: number) => [cal.ox + x * cal.sx, cal.oy + y * cal.sy] as const
  const move = async (page: Page, x: number, y: number, steps = 6) => {
    const [px, py] = S(x, y)
    await page.mouse.move(px, py, { steps })
  }
  const click = async (page: Page, x: number, y: number) => {
    const [px, py] = S(x, y)
    await page.mouse.click(px, py)
  }
  const hint = async (page: Page) => (await page.locator('#status-hint').textContent()) ?? ''
  let shotIndex = 0
  const shot = async (page: Page, name: string) => {
    await page.waitForTimeout(200)
    const dir = SHOTS ?? test.info().outputDir
    await page.screenshot({
      path: `${dir}/${test.info().title.replace(/\W+/g, '-').slice(0, 24)}-${String(++shotIndex).padStart(2, '0')}-${name}.png`,
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
    })
  }

  test.beforeEach(async ({ page }) => {
    shotIndex = 0
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 15_000 })
    await page.waitForTimeout(1000)
    box = (await page.locator('#plan-canvas').boundingBox())!
    await page.mouse.move(box.x + 50, box.y + 50)
    await calibrate(page)
    await page.evaluate(() => {
      const m = (window as any).__model
      const pts = [[-100, -100], [300, -100], [300, 200], [-100, 200]]
      pts.forEach((p, i) => {
        const q = pts[(i + 1) % 4]!
        m.addWall({ xStart: p[0], yStart: p[1], xEnd: q[0], yEnd: q[1], thickness: 10, height: 250, levelRef: null })
      })
      m.addRoom(pts, { name: 'Room' })
    })
    await page.waitForTimeout(500)
    await calibrate(page)
    await page.locator('button[data-tool="dimensionLine"]').click()
  })

  test('hover shows the way in; click a wall dimensions it in one go', async ({ page }) => {
    await move(page, 100, -60)
    expect(await hint(page)).toContain('Click a wall')
    await shot(page, 'hover-empty-space')
    await move(page, 180, -100)
    await shot(page, 'hover-wall-candidate')
    await move(page, 100, -100)
    await shot(page, 'hover-wall-midpoint-anchor')
    await move(page, -98, -98)
    await shot(page, 'hover-corner-anchor')
    await move(page, 180, -100)
    await click(page, 180, -100)
    await shot(page, 'wall-dimensioned')
    const d = await dims(page)
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ xStart: -100, yStart: -100, xEnd: 300, yEnd: -100, offset: -40 })
    // Selected straight away, so it can be dragged to a better offset.
    const selection = await page.evaluate(() => (window as any).__model.getStore().getHome().selection)
    expect(selection).toEqual([d[0]!.id])
  })

  test('three clicks: start, end, then pull the line out and place it', async ({ page }) => {
    await move(page, -98, 198)
    await click(page, -98, 198)
    expect(await hint(page)).toContain('2nd point')
    await move(page, 100, 205)
    await shot(page, 'second-point-live-preview')
    await move(page, 298, 198)
    await shot(page, 'second-point-on-corner')
    await click(page, 298, 198)
    // Not placed yet: the line is now being pulled out.
    expect(await dims(page)).toHaveLength(0)
    expect(await hint(page)).toContain('pull the dimension line out')
    await move(page, 100, 230)
    await shot(page, 'pulling-offset')
    await move(page, 100, 262)
    await shot(page, 'pulling-offset-farther')
    await click(page, 100, 262)
    await shot(page, 'placed')
    const d = await dims(page)
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ xStart: -100, yStart: 200, xEnd: 300, yEnd: 200, offset: 60 })
  })

  test('Backspace steps back one stage and Escape cancels', async ({ page }) => {
    await click(page, -98, 198)
    await move(page, 298, 198)
    await click(page, 298, 198)
    expect(await hint(page)).toContain('pull the dimension line out')
    await page.keyboard.press('Backspace')
    expect(await hint(page)).toContain('2nd point')
    await click(page, 298, 198)
    await page.keyboard.press('Escape')
    expect(await hint(page)).toContain('Click a wall')
    expect(await dims(page)).toHaveLength(0)
  })

  test('typed length then Enter, Enter again places it at the live offset', async ({ page }) => {
    await click(page, -98, 198)
    await move(page, 200, 200)
    for (const ch of '250') await page.keyboard.press(ch)
    await page.keyboard.press('Enter')
    expect(await hint(page)).toContain('pull the dimension line out')
    await move(page, 0, 250)
    await page.keyboard.press('Enter')
    const d = await dims(page)
    expect(d).toHaveLength(1)
    expect(Math.hypot(d[0]!.xEnd! - d[0]!.xStart!, d[0]!.yEnd! - d[0]!.yStart!)).toBeCloseTo(250, 3)
    expect(d[0]!.offset).toBe(50)
  })

  for (const [label, wheel] of [['zoomed-in', -1500], ['zoomed-out', 1500]] as const) {
    test(`one-click wall dimension and selection at ${label} zoom`, async ({ page }) => {
      const [cx, cy] = S(100, 50)
      await page.mouse.move(cx, cy)
      await page.mouse.wheel(0, wheel)
      await page.waitForTimeout(200)
      await calibrate(page)
      await move(page, 180, -100)
      await shot(page, `${label}-hover-wall`)
      await click(page, 180, -100)
      await shot(page, `${label}-wall-dimensioned`)
      expect(await dims(page)).toHaveLength(1)
      // Select tool: hover, drag the offset, delete.
      await page.locator('button[data-tool="selection"]').click()
      await page.keyboard.press('Escape')
      const d = (await dims(page))[0]!
      // Top wall: the line sits d.offset cm below the wall (negative = above); its text is mid-line at x=100.
      const lineY = -100 + d.offset!
      await move(page, 100, lineY)
      await shot(page, `${label}-select-hover`)
      await page.mouse.down()
      await move(page, 100, lineY + 70)
      await shot(page, `${label}-offset-drag`)
      await page.mouse.up()
      expect((await dims(page))[0]!.offset).not.toBe(d.offset)
      await page.keyboard.press('Delete')
      await shot(page, `${label}-deleted`)
      expect(await dims(page)).toHaveLength(0)
    })
  }
})
