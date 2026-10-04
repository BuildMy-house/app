import { test, expect } from '@playwright/test'

test('plan furniture rotates continuously during drag and stays undoable as one edit', async ({ page }) => {
  await page.goto('/')
  const canvas = page.locator('#plan-canvas')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  const cx = box!.x + box!.width / 2
  const cy = box!.y + box!.height / 2
  const modelPointAt = async (x: number, y: number) => {
    await page.mouse.move(x, y)
    const status = await page.locator('#status-cursor').textContent()
    const match = status?.match(/x:\s*(-?[\d.]+)\s+y:\s*(-?[\d.]+)/)
    expect(match).not.toBeNull()
    return { x: Number(match![1]), y: Number(match![2]) }
  }
  const center = await modelPointAt(cx, cy)
  const id = await page.evaluate(({ x, y }) => {
    const model = (window as any).__model
    const f = model.addFurniture({ name: 'Rotation test', x, y, angleDeg: 0, width: 60, depth: 40, height: 50, elevation: 0 })
    model.setSelection([f.id])
    return f.id
  }, center)
  const zoom = await page.locator('#status-zoom').textContent()
  const pxPerCm = Number(zoom?.match(/[\d.]+/)?.[0]) / 100
  const ringPx = 80 // arbitrary pointer-arc radius; rotation is angle-based
  const start = { x: cx, y: cy - (20 * pxPerCm + 22) } // knob: half depth + 22px stem
  const atAngle = (deg: number) => ({
    x: cx + ringPx * Math.sin((deg * Math.PI) / 180),
    y: cy - ringPx * Math.cos((deg * Math.PI) / 180),
  })
  await page.mouse.move(start.x, start.y)

  await page.mouse.down()
  await page.mouse.move(atAngle(22.5).x, atAngle(22.5).y, { steps: 5 })
  const middleAngle = await page.evaluate((furnitureId) =>
    (window as any).__model.getStore().getHome().furniture.find((f: any) => f.id === furnitureId).angleDeg, id)
  expect(middleAngle).toBeCloseTo(22.5, 0)

  await page.mouse.move(atAngle(45).x, atAngle(45).y, { steps: 5 })
  await page.mouse.up()
  const finalAngle = await page.evaluate((furnitureId) =>
    (window as any).__model.getStore().getHome().furniture.find((f: any) => f.id === furnitureId).angleDeg, id)
  expect(finalAngle).toBeCloseTo(45, 0)

  await page.keyboard.press('Control+z')
  const revertedAngle = await page.evaluate((furnitureId) =>
    (window as any).__model.getStore().getHome().furniture.find((f: any) => f.id === furnitureId).angleDeg, id)
  expect(revertedAngle).toBe(0)

  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 35, cy + 25, { steps: 5 })
  const movingPosition = await page.evaluate((furnitureId) => {
    const f = (window as any).__model.getStore().getHome().furniture.find((item: any) => item.id === furnitureId)
    return { x: f.x, y: f.y }
  }, id)
  expect(movingPosition.x).toBeGreaterThan(center.x)
  await page.mouse.up()
})
