import { test, expect } from '@playwright/test'

/**
 * M66 regression: selecting a furniture piece that loads a GLB model must not
 * permanently blue-tint every other instance of the same catalog model.
 *
 * Root cause was Object3D.clone() sharing the cached GLB material, so
 * tintEmissive() mutated the one shared material in place and never reversed
 * it. The fix clones each material per-instance in addModel() before any
 * highlight mutation, and clears emissive on deselect.
 *
 * This test reads the ACTUAL Three.js material.emissive values off the live
 * scene — the same live probe the bug was reproduced with.
 */

test.describe('furniture selection material isolation (M66)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
    await page.waitForFunction(() => (window as any).__view3d?.scene, null, { timeout: 10_000 })
    await page.waitForFunction(() => (window as any).__model, null, { timeout: 10_000 })
  })

  /** Read each furniture instance's child-model submesh material emissive hex (0=black). */
  async function emissiveHexes(page: import('@playwright/test').Page): Promise<Record<string, number[]>> {
    return page.evaluate(() => {
      const scene = (window as any).__view3d.scene as any
      const out: Record<string, number[]> = {}
      scene.traverse((obj: any) => {
        if (obj.isMesh && obj.name.startsWith('furniture:')) {
          const id = obj.name.slice('furniture:'.length)
          const hexes: number[] = []
          // The GLB model is a child of the furniture mesh; tint is applied to
          // the model's sub-meshes, so walk the subtree below this furniture.
          obj.traverse((child: any) => {
            if (child.isMesh && child !== obj) {
              for (const m of Array.isArray(child.material) ? child.material : [child.material]) {
                const hex = m.emissive?.getHex?.()
                if (hex !== undefined) hexes.push(hex)
              }
            }
          })
          if (hexes.length > 0) out[id] = hexes
        }
      })
      return out
    })
  }

  test('selecting one instance leaves the sibling exactly black', async ({ page }) => {
    const ids = await page.evaluate(() => {
      const model = (window as any).__model
      const a = model.addFurniture({
        name: 'A', catalogId: 'eTeks#bookcase', modelPath: 'models/eteks-bookcase.glb',
        x: 0, y: 0, angleDeg: 0, width: 100, depth: 40, height: 211,
        elevation: 0, color: null, doorOrWindow: false,
      })
      const b = model.addFurniture({
        name: 'B', catalogId: 'eTeks#bookcase', modelPath: 'models/eteks-bookcase.glb',
        x: 500, y: 0, angleDeg: 0, width: 100, depth: 40, height: 211,
        elevation: 0, color: null, doorOrWindow: false,
      })
      model.setSelection([a.id])
      return [a.id, b.id] as [string, string]
    })
    // Wait for the async GLB load + swapInModel + highlight to land: the
    // selected instance's child-model submeshes must show non-black emissive.
    await page.waitForFunction(([aid]) => {
      const scene = (window as any).__view3d.scene
      const mats: number[] = []
      scene.traverse((obj: any) => {
        if (obj.isMesh && obj.name === `furniture:${aid}`) {
          obj.traverse((child: any) => {
            if (child.isMesh && child !== obj) {
              for (const m of Array.isArray(child.material) ? child.material : [child.material]) {
                const hex = m.emissive?.getHex?.()
                if (hex !== undefined) mats.push(hex)
              }
            }
          })
        }
      })
      return mats.length > 0 && mats.every((h) => h !== 0x000000)
    }, ids, { timeout: 15_000 })
    await page.waitForTimeout(300)

    const emissives = await emissiveHexes(page)
    for (const id of ids) {
      expect(emissives[id], `instance ${id} has meshes`).toBeDefined()
      expect(emissives[id]!.length).toBeGreaterThan(0)
    }
    // Selected (A) must be tinted; sibling (B) must be exactly black.
    for (const hex of emissives[ids[0]]!) expect(hex).not.toBe(0x000000)
    for (const hex of emissives[ids[1]]!) expect(hex).toBe(0x000000)
  })

  test('deselecting returns the previously-selected material to black', async ({ page }) => {
    const id = await page.evaluate(() => {
      const model = (window as any).__model
      const a = model.addFurniture({
        name: 'A', catalogId: 'eTeks#bookcase', modelPath: 'models/eteks-bookcase.glb',
        x: 0, y: 0, angleDeg: 0, width: 100, depth: 40, height: 211,
        elevation: 0, color: null, doorOrWindow: false,
      })
      model.setSelection([a.id])
      return a.id
    })
    // Wait until the async GLB load lands and the selected instance's child
    // submeshes carry the highlight.
    await page.waitForFunction(([aid]) => {
      const scene = (window as any).__view3d.scene
      const mats: number[] = []
      scene.traverse((obj: any) => {
        if (obj.isMesh && obj.name === `furniture:${aid}`) {
          obj.traverse((child: any) => {
            if (child.isMesh && child !== obj) {
              for (const m of Array.isArray(child.material) ? child.material : [child.material]) {
                const hex = m.emissive?.getHex?.()
                if (hex !== undefined) mats.push(hex)
              }
            }
          })
        }
      })
      return mats.length > 0 && mats.every((h) => h !== 0x000000)
    }, [id], { timeout: 15_000 })

    // While selected, it must be tinted.
    let emissives = await emissiveHexes(page)
    for (const hex of emissives[id]!) expect(hex).not.toBe(0x000000)

    // Deselect fully.
    await page.evaluate(() => (window as any).__model.setSelection([]))
    await page.waitForTimeout(300)

    emissives = await emissiveHexes(page)
    for (const hex of emissives[id]!) expect(hex).toBe(0x000000)
  })
})
