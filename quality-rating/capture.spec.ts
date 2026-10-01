import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { ViewportQualitySnapshot } from '../src/telemetry/events'
import { gradeHeuristics } from './heuristics'
import { judgeScreenshots, type QualityRecord } from './vision-judge'

// Mirrors STORAGE_KEY in src/view3d/viewport-quality.ts (not exported).
// loadViewportQuality fills unspecified fields from the base preset, so a
// bare {preset} object is enough to switch tiers.
const QUALITY_STORAGE_KEY = 'homely-viewport-quality'

const TIERS = ['low', 'medium', 'high', 'ultra'] as const

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-')
const RUN_DIR = path.resolve('quality-rating/reports', RUN_ID)

const records: QualityRecord[] = []

type SceneId = 'empty-room' | 'furnished-living-room' | 'glass-window-scene'

interface SceneDef {
  build: (page: Page) => Promise<void>
  /** > 0 marks the scene as one where LOD culling should visibly reduce draw calls. */
  lodExpectedFraction: number
}

async function clickFraction(page: Page, fx: number, fy: number): Promise<void> {
  const box = await page.locator('#plan-canvas').boundingBox()
  if (!box) throw new Error('#plan-canvas has no bounding box')
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy)
}

/** Closed 400×400cm square room. Coordinates are app-world centimeters. */
async function buildWalls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const model = (window as unknown as { __model: ModelBridge }).__model
    const s = model.addWall({ xStart: -200, yStart: -200, xEnd: 200, yEnd: -200, height: 250, thickness: 10 })
    const e = model.addWall({ xStart: 200, yStart: -200, xEnd: 200, yEnd: 200, height: 250, thickness: 10 })
    const n = model.addWall({ xStart: 200, yStart: 200, xEnd: -200, yEnd: 200, height: 250, thickness: 10 })
    const w = model.addWall({ xStart: -200, yStart: 200, xEnd: -200, yEnd: -200, height: 250, thickness: 10 })
    return [s.id, e.id, n.id, w.id]
  })
}

async function placeFromCatalog(page: Page, name: string, fx: number, fy: number): Promise<void> {
  // The catalog grid is virtualized (MAT-T9): cards far down the list are not
  // in the DOM until scrolled into view, so search first to mount the target
  // card. The card may be a variant matching the text — fine for rating
  // purposes; exact items are only required for glass, which mounts via the
  // store API instead.
  //
  // NEVER clear the search box between placements: fill('') re-renders the
  // virtualized grid and, while placement state is recent, the store loses
  // the just-placed furniture (observed: count reset 1→0 after every clear;
  // counts accumulated 1→8 once the clear was dropped). fill(name) replaces
  // the value wholesale on the next placement, so no clear is needed.
  const countBefore = await page.evaluate(
    () =>
      (
        window as unknown as {
          __model: ModelBridge & { getStore(): { getHome(): { furniture: unknown[] } } }
        }
      ).__model.getStore().getHome().furniture.length,
  )
  await page.locator('.catalog-search').fill(name)
  await page.locator('.catalog-card').filter({ hasText: name }).first().click()
  // State gates, not sleeps: arming is async, and a canvas click that lands
  // before placement mode is armed is silently swallowed by the selection
  // tool (observed: 8/8 placements lost with no error).
  await expect(page.locator('.catalog-status')).toContainText('Placing:', { timeout: 5_000 })
  await clickFraction(page, fx, fy)
  // Catalog auto-disarms on placement; the count guard catches silent no-ops.
  await expect(page.locator('.catalog-status')).toContainText('Click a piece to place it', {
    timeout: 5_000,
  })
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __model: ModelBridge & { getStore(): { getHome(): { furniture: unknown[] } } }
              }
            ).__model.getStore().getHome().furniture.length,
        ),
      { timeout: 5_000 },
    )
    .toBe(countBefore + 1)
}

interface ModelBridge {
  addWall(wall: {
    xStart: number
    yStart: number
    xEnd: number
    yEnd: number
    height: number
    thickness: number
  }): { id: string }
  addFurniture(item: {
    name: string
    x: number
    y: number
    angleDeg: number
    width: number
    depth: number
    height: number
    elevation: number
    doorOrWindow: boolean
    wallRef?: string
    wallOffset?: number
  }): { id: string }
}

/**
 * Mounts doors/windows through the store API (same pattern as
 * e2e/door-window-wall-cutouts.spec.ts) instead of wall-proximity clicking —
 * wallRef + wallOffset is deterministic, clicks near walls are not.
 */
async function mountGlass(page: Page, name: string, wallId: string, wallLength: number): Promise<void> {
  await page.evaluate(
    ({ bridge, wallId, wallLength }) => {
      const model = (window as unknown as { __model: ModelBridge }).__model
      model.addFurniture({
        name: bridge.name,
        x: 0,
        y: 0,
        angleDeg: 0,
        width: 100,
        depth: 10,
        height: 150,
        elevation: 80,
        doorOrWindow: true,
        wallRef: wallId,
        wallOffset: wallLength / 2,
      })
    },
    { bridge: { name }, wallId, wallLength },
  )
}

const SCENES: Record<SceneId, SceneDef> = {
  'empty-room': {
    build: async (page) => {
      await buildWalls(page)
    },
    lodExpectedFraction: 0,
  },
  'furnished-living-room': {
    build: async (page) => {
      await buildWalls(page)
      await placeFromCatalog(page, 'Sofa', 0.5, 0.6)
      await placeFromCatalog(page, 'Bar table', 0.4, 0.45)
      await placeFromCatalog(page, 'Bar table', 0.6, 0.45)
      await placeFromCatalog(page, 'Chair', 0.45, 0.55)
      await placeFromCatalog(page, 'Office chair', 0.55, 0.55)
      await placeFromCatalog(page, 'Lattice chair', 0.5, 0.4)
      await placeFromCatalog(page, 'Plant', 0.38, 0.38)
      await placeFromCatalog(page, 'Stainless steel shelf', 0.62, 0.38)
    },
    lodExpectedFraction: 0.1,
  },
  'glass-window-scene': {
    build: async (page) => {
      const wallIds = await buildWalls(page)
      await mountGlass(page, 'Window', wallIds[0], 400)
      await mountGlass(page, 'Triple window', wallIds[2], 400)
      await mountGlass(page, 'Glass door', wallIds[1], 400)
      await placeFromCatalog(page, 'Sofa', 0.5, 0.6)
      await placeFromCatalog(page, 'Plant', 0.38, 0.38)
    },
    lodExpectedFraction: 0.1,
  },
}

/**
 * Samples 30 RAF frame deltas in the live page. Deliberately calls the
 * private collectViewportQualitySnapshot() on window.__view3d (the same
 * escape hatch existing e2e specs use) instead of waiting for the app's 30s
 * telemetry timer — we want the app's exact snapshot logic on demand, not a
 * second implementation.
 */
async function readSnapshot(page: Page): Promise<ViewportQualitySnapshot> {
  const snapshot = await page.evaluate(() => {
    const view3d = (
      window as unknown as {
        __view3d?: { collectViewportQualitySnapshot(): Record<string, unknown> }
      }
    ).__view3d
    if (!view3d) throw new Error('window.__view3d is not available')
    return view3d.collectViewportQualitySnapshot()
  })
  expect(snapshot, 'viewport quality snapshot collected').toBeTruthy()
  return snapshot as unknown as ViewportQualitySnapshot
}

async function sampleFrameTimes(page: Page): Promise<number[]> {
  return page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const times: number[] = []
        let last = performance.now()
        let count = 0
        const step = (now: number) => {
          times.push(now - last)
          last = now
          count += 1
          if (count >= 30) {
            resolve(times)
          } else {
            requestAnimationFrame(step)
          }
        }
        requestAnimationFrame(step)
      }),
  )
}

test.beforeAll(() => {
  fs.mkdirSync(RUN_DIR, { recursive: true })
})

test.afterAll(async () => {
  if (records.length === 0) return
  await judgeScreenshots(records)
  const summaryPath = path.join(RUN_DIR, 'summary.json')
  fs.writeFileSync(summaryPath, JSON.stringify(records, null, 2))
  fs.copyFileSync(summaryPath, path.resolve('quality-rating/reports/latest.json'))
  console.log(`[quality-rating] wrote ${records.length} records to ${summaryPath}`)
})

for (const sceneId of Object.keys(SCENES) as SceneId[]) {
  for (const tier of TIERS) {
    test(`${sceneId} · ${tier}`, async ({ page }) => {
      await page.addInitScript(
        ([key, seed]) => {
          window.localStorage.setItem(key, seed)
        },
        [QUALITY_STORAGE_KEY, JSON.stringify({ preset: tier })],
      )

      await page.goto('/')
      await expect(page.locator('#plan-canvas')).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('.catalog-card').first()).toBeVisible({ timeout: 10_000 })

      const scene = SCENES[sceneId]
      await scene.build(page)

      await page.locator('button[data-preset="3d"]').click()
      await expect(page.locator('#view3d canvas')).toBeVisible({ timeout: 10_000 })
      await page.locator('#btn-fit').click()
      // Settle: camera animation + GLB streaming (glass items load remote models).
      await page.waitForTimeout(1500)

      for (const camera of ['observer', 'top'] as const) {
        await page.locator(`button[data-camera3d="${camera}"]`).click()
        await page.waitForTimeout(800)

        const [frameTimes, snapshot] = await Promise.all([
          sampleFrameTimes(page),
          readSnapshot(page),
        ])
        const grade = gradeHeuristics(snapshot, {
          expectedLodCullScreenFraction: scene.lodExpectedFraction,
          priorFrameTimesMs: frameTimes,
        })

        const fileBase = `${sceneId}-${tier}-${camera}`
        const screenshotRelative = `quality-rating/reports/${RUN_ID}/${fileBase}.png`
        await page.locator('#view3d').screenshot({ path: path.resolve(screenshotRelative) })

        const record: QualityRecord = {
          runId: RUN_ID,
          scene: sceneId,
          tier,
          camera,
          screenshot: screenshotRelative,
          snapshot: snapshot as unknown as Record<string, unknown>,
          heuristic: grade,
        }
        records.push(record)
        fs.writeFileSync(
          path.join(RUN_DIR, `${fileBase}.json`),
          JSON.stringify(record, null, 2),
        )
      }
    })
  }
}
