import { expect, type Page } from '@playwright/test'

export interface PlanMapping {
  /** Screen position of a model point (cm) on the plan canvas. */
  toScreen: (x: number, y: number) => { x: number; y: number }
  pxPerCm: number
}

/**
 * Measures the plan's current model -> screen mapping by probing the cursor
 * readout at two screen points. Call it AFTER building the scene: adding walls
 * can refit the viewport, which would invalidate an earlier measurement.
 */
export async function measurePlan(page: Page): Promise<PlanMapping> {
  const canvas = page.locator('#plan-canvas')
  await expect(canvas).toBeVisible()
  const box = (await canvas.boundingBox())!
  const probe = async (sx: number, sy: number) => {
    await page.mouse.move(sx, sy)
    const status = await page.locator('#status-cursor').textContent()
    const match = status?.match(/x:\s*(-?[\d.]+)\s+y:\s*(-?[\d.]+)/)
    expect(match).not.toBeNull()
    return { x: Number(match![1]), y: Number(match![2]) }
  }
  const s0 = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.4 }
  const s1 = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.6 }
  const m0 = await probe(s0.x, s0.y)
  const m1 = await probe(s1.x, s1.y)
  // The readout is rounded to 0.1 cm; the two probes are far apart so the scale error is negligible.
  const pxPerCm = (s1.x - s0.x) / (m1.x - m0.x)
  return {
    pxPerCm,
    toScreen: (x, y) => ({ x: s0.x + (x - m0.x) * pxPerCm, y: s0.y + (y - m0.y) * pxPerCm }),
  }
}
