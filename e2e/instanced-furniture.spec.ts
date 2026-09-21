import { expect, test, type Page } from '@playwright/test'

interface SceneProbe {
  instanced: { name: string; count: number }[]
  individual: number
  drawCalls: number
}

async function addChairs(page: Page, count: number, distinctWidths = false) {
  await page.evaluate(
    ({ count, distinctWidths }) => {
      const store = (window as any).__model.getStore()
      store.apply((d: any) => {
        d.furniture = Array.from({ length: count }, (_, i) => ({
          id: `chair-${i}`,
          catalogId: 'chair-a',
          x: 0,
          y: i * 3,
          angleDeg: 0,
          width: distinctWidths ? 40 + i : 40,
          height: 80,
          depth: 40,
          elevation: 0,
          visible: true,
        }))
      })
    },
    { count, distinctWidths },
  )
}

async function clearFurniture(page: Page) {
  await page.evaluate(() => {
    const store = (window as any).__model.getStore()
    store.apply((d: any) => {
      d.furniture = []
    })
  })
}

async function probeScene(page: Page): Promise<SceneProbe> {
  return page.evaluate(() => {
    const view = (window as any).__view3d
    view.render()
    const instanced: { name: string; count: number }[] = []
    let individual = 0
    view.scene.traverse((o: any) => {
      if (o.isInstancedMesh) instanced.push({ name: o.name, count: o.count })
      else if (o.name.startsWith('furniture:')) individual++
    })
    // Sample draw calls from a raw scene render, bypassing the post-processing
    // composer (RenderPass/Bloom/SSAO/GTAO/OutputPass): each of those passes
    // does its own internal renderer.render() call, and three.js's WebGLInfo
    // resets `info.render.calls` at the START of every renderer.render() call
    // -- so with the composer active, reading info.render.calls right after
    // view.render() only reflects the LAST pass's (e.g. OutputPass's single
    // fullscreen-quad) call count, not the actual scene complexity. A direct,
    // composer-free render of the same scene/camera restores a draw-call
    // count that's representative of instancing, independent of whatever
    // post-processing pipeline happens to be active.
    ;(view as any).renderer.render(view.scene, view.camera)
    return { instanced, individual, drawCalls: (view as any).renderer.info.render.calls }
  })
}

test.describe('instanced furniture (T1)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas')
    await page.waitForFunction(() => (window as any).__view3d && (window as any).__model)
    await page.waitForFunction(() => (window as any).__view3d.scene)
  })

  test('25 identical chairs collapse into one instanced mesh and cut draw calls', async ({ page }) => {
    await addChairs(page, 25, true) // distinct widths -> no grouping -> baseline
    const baseline = await probeScene(page)
    expect(baseline.instanced).toHaveLength(0)
    expect(baseline.individual).toBe(25)

    await clearFurniture(page)
    await addChairs(page, 25, false)
    const probe = await probeScene(page)
    expect(probe.individual).toBe(0)
    expect(probe.instanced).toHaveLength(1)
    expect(probe.instanced[0].count).toBe(25)
    expect(probe.drawCalls).toBeLessThan(baseline.drawCalls * 0.6)

    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.waitForTimeout(500)
    expect(errors).toEqual([])
  })

  test('selecting one chair detaches it into a tinted individual mesh', async ({ page }) => {
    await addChairs(page, 20)
    const id = await page.evaluate(
      () => (window as any).__model.getStore().getHome().furniture[7].id,
    )
    await page.evaluate((id) => {
      ;(window as any).__model.setSelection([id])
    }, id)

    const probe = await probeScene(page)
    const totalInstanced = probe.instanced.reduce((n, g) => n + g.count, 0)
    expect(totalInstanced).toBe(19)
    const tinted = await page.evaluate((id) => {
      let emissive: string | null = null
      ;(window as any).__view3d.scene.traverse((o: any) => {
        if (o.name === `furniture:${id}`) emissive = o.material.emissive.getHexString()
      })
      return emissive
    }, id)
    expect(tinted).not.toBe('000000')
  })

  test('clicking an instanced chair selects it', async ({ page }) => {
    await addChairs(page, 20)
    await page.evaluate(() => {
      const view = (window as any).__view3d
      view.controls.target.set(0, 40, 0)
      view.controls.update()
    })
    await page.waitForTimeout(200)
    const box = await page.locator('#view3d canvas').boundingBox()
    if (!box) throw new Error('no canvas box')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(400)

    const selection = await page.evaluate(() =>
      (window as any).__model.getStore().getHome().selection,
    )
    const firstId = await page.evaluate(
      () => (window as any).__model.getStore().getHome().furniture[0].id,
    )
    expect(selection).toContain(firstId)
  })
})
