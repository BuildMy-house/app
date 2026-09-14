import { test, expect } from '@playwright/test'

test.describe('wall-opening cutouts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  })

  test('places a door on a wall and shows opening in 3D', async ({ page }) => {
    const wallId = await page.evaluate(() => {
      const m = (window as any).__model
      const w = m.addWall({
        xStart: 0, yStart: 0, xEnd: 400, yEnd: 0,
        height: 250, thickness: 15,
      })
      return w?.id
    })
    expect(wallId).toBeTruthy()

    const doorId = await page.evaluate((wid: string) => {
      const m = (window as any).__model
      const d = m.addFurniture({
        name: 'Door', x: 200, y: 0, angleDeg: 0,
        width: 90, depth: 15, height: 210, elevation: 0,
        doorOrWindow: true, wallRef: wid, wallOffset: 200,
      })
      return d?.id
    }, wallId)
    expect(doorId).toBeTruthy()

    const furnitureState = await page.evaluate((did: string) => {
      const home = (window as any).__model.getStore().getHome()
      return home.furniture.find((f: any) => f.id === did)
    }, doorId)
    expect(furnitureState.wallRef).toBe(wallId)

    const boxCount = await page.evaluate((wid: string) => {
      const home = (window as any).__model.getStore().getHome()
      const result = (window as any).__buildRenderableScene(home)
      const wallObj = result.scene.objects.find((o: any) => o.id === `wall:${wid}`)
      return wallObj?.primitives?.filter((p: any) => p.type === 'box')?.length ?? 0
    }, wallId)
    expect(boxCount).toBe(6)

    const canvasVisible = await page.locator('#view3d canvas').isVisible()
    expect(canvasVisible).toBe(true)
  })

  test('places a window on a wall and generates sill/lintel boxes', async ({ page }) => {
    const wallId = await page.evaluate(() => {
      const m = (window as any).__model
      const w = m.addWall({
        xStart: 0, yStart: 0, xEnd: 400, yEnd: 0,
        height: 250, thickness: 15,
      })
      return w?.id
    })
    expect(wallId).toBeTruthy()

    const windowId = await page.evaluate((wid: string) => {
      const m = (window as any).__model
      const w = m.addFurniture({
        name: 'Window', x: 200, y: 0, angleDeg: 0,
        width: 120, depth: 15, height: 120, elevation: 90,
        doorOrWindow: true, wallRef: wid, wallOffset: 200,
      })
      return w?.id
    }, wallId)
    expect(windowId).toBeTruthy()

    const furnitureState = await page.evaluate((did: string) => {
      const home = (window as any).__model.getStore().getHome()
      return home.furniture.find((f: any) => f.id === did)
    }, windowId)
    expect(furnitureState.wallRef).toBe(wallId)

    const boxCount = await page.evaluate((wid: string) => {
      const home = (window as any).__model.getStore().getHome()
      const result = (window as any).__buildRenderableScene(home)
      const wallObj = result.scene.objects.find((o: any) => o.id === `wall:${wid}`)
      return wallObj?.primitives?.filter((p: any) => p.type === 'box')?.length ?? 0
    }, wallId)
    expect(boxCount).toBe(8)

    const canvasVisible = await page.locator('#view3d canvas').isVisible()
    expect(canvasVisible).toBe(true)
  })
})
