import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  KNOWN_BAD_CATALOG_IDS,
  KNOWN_BAD_POSITIONS,
  KNOWN_BAD_SEARCH_NAMES,
  STANDARD_CAMERA_PRESET,
} from './known-bad-scene'

// Photoreal test-house fixtures (aqs-5). Mirrors quality-rating/capture.spec.ts:
// store-API walls (window.__model.addWall), catalog placement via search+click,
// NEVER clearing the catalog search box between placements (virtualized-grid
// bug drops already-placed furniture). Both scenes export the store home JSON
// with STANDARD_CAMERA_PRESET applied (hdriPreset + observer yaw/pitch) so the
// MCP/LuxCore render path and the browser path share one scene definition.

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-')
const RUN_DIR = path.resolve('quality-rating/reports/photoreal-fixtures', RUN_ID)

interface WallIds {
  south: string
  east: string
  north: string
  west: string
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
  getStore(): { getHome(): { furniture: unknown[] } }
}

async function buildWalls(page: Page): Promise<WallIds> {
  return page.evaluate(() => {
    const model = (window as unknown as { __model: ModelBridge }).__model
    const south = model.addWall({ xStart: -200, yStart: -200, xEnd: 200, yEnd: -200, height: 250, thickness: 10 })
    const east = model.addWall({ xStart: 200, yStart: -200, xEnd: 200, yEnd: 200, height: 250, thickness: 10 })
    const north = model.addWall({ xStart: 200, yStart: 200, xEnd: -200, yEnd: 200, height: 250, thickness: 10 })
    const west = model.addWall({ xStart: -200, yStart: 200, xEnd: -200, yEnd: -200, height: 250, thickness: 10 })
    return { south: south.id, east: east.id, north: north.id, west: west.id }
  })
}

async function clickFraction(page: Page, fx: number, fy: number): Promise<void> {
  const box = await page.locator('#plan-canvas').boundingBox()
  if (!box) throw new Error('#plan-canvas not visible')
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy)
}

async function placeFromCatalog(page: Page, name: string, fx: number, fy: number): Promise<void> {
  const countBefore = await page.evaluate(
    () => (window as unknown as { __model: ModelBridge }).__model.getStore().getHome().furniture.length,
  )
  await page.locator('.catalog-search').fill(name)
  await page.locator('.catalog-card').filter({ hasText: name }).first().click()
  await expect(page.locator('.catalog-status')).toContainText('Placing:', { timeout: 5000 })
  await clickFraction(page, fx, fy)
  await expect(page.locator('.catalog-status')).toContainText('Click a piece to place it', { timeout: 5000 })
  await expect
    .poll(
      async () =>
        page.evaluate(
          () => (window as unknown as { __model: ModelBridge }).__model.getStore().getHome().furniture.length,
        ),
      { timeout: 5000 },
    )
    .toBe(countBefore + 1)
}

function fractionOf(x: number, y: number): { fx: number; fy: number } {
  // Room is 400x400cm centred on the origin -> map world cm to canvas fraction.
  return { fx: (x + 200) / 400, fy: (y + 200) / 400 }
}

async function openWorkspace(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('#plan-canvas')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.catalog-card').first()).toBeVisible({ timeout: 10000 })
}

async function finishScene(page: Page, sceneName: string): Promise<void> {
  await page.locator('button[data-preset="3d"]').click()
  await expect(page.locator('#view3d canvas')).toBeVisible({ timeout: 10000 })
  await page.locator('#btn-fit').click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: path.join(RUN_DIR, `${sceneName}-3d.png`) })
  // Export the store home with the standardized photoreal preset merged in so
  // the JSON is directly renderable by the LuxCore bridge (bridge.py reads
  // environment.hdriPreset and cameras.observer yawDeg/pitchDeg).
  const home = await page.evaluate((preset) => {
    const store = (window as unknown as { __model: ModelBridge }).__model.getStore()
    const homeJson = JSON.parse(JSON.stringify(store.getHome()))
    homeJson.environment = { ...(homeJson.environment || {}), hdriPreset: preset.hdri }
    homeJson.cameras = {
      ...(homeJson.cameras || {}),
      observer: {
        x: 0,
        y: 0,
        z: preset.heightCm,
        yawDeg: preset.azimuth,
        pitchDeg: preset.elevation,
        fovDeg: preset.fovDeg,
      },
    }
    return homeJson
  }, STANDARD_CAMERA_PRESET)
  fs.writeFileSync(path.join(RUN_DIR, `${sceneName}.home.json`), JSON.stringify(home, null, 2))
}

test.describe('photoreal test-house fixtures', () => {
  test.beforeAll(() => {
    fs.mkdirSync(RUN_DIR, { recursive: true })
  })

  test('known-bad scene: 11 textureless catalog items in a 400x400 room', async ({ page }) => {
    await openWorkspace(page)
    await buildWalls(page)
    for (let i = 0; i < KNOWN_BAD_CATALOG_IDS.length; i++) {
      const pos = KNOWN_BAD_POSITIONS[i]
      const { fx, fy } = fractionOf(pos.x, pos.y)
      // Doors/windows from this list may auto-mount to a nearby wall on
      // placement; the furniture-count assert tolerates either placement mode.
      await placeFromCatalog(page, KNOWN_BAD_SEARCH_NAMES[i], fx, fy)
    }
    const placed = await page.evaluate(
      () => (window as unknown as { __model: ModelBridge }).__model.getStore().getHome().furniture.length,
    )
    expect(placed).toBeGreaterThanOrEqual(KNOWN_BAD_CATALOG_IDS.length)
    await finishScene(page, 'known-bad-scene')
  })

  test('furnished living room', async ({ page }) => {
    await openWorkspace(page)
    await buildWalls(page)
    const placements: Array<[string, number, number]> = [
      ['Sofa', 0.5, 0.6],
      ['Bar table', 0.4, 0.45],
      ['Bar table', 0.6, 0.45],
      ['Chair', 0.45, 0.55],
      ['Office chair', 0.55, 0.55],
      ['Lattice chair', 0.5, 0.4],
      ['Plant', 0.38, 0.38],
      ['Stainless steel shelf', 0.62, 0.38],
    ]
    for (const [name, fx, fy] of placements) {
      await placeFromCatalog(page, name, fx, fy)
    }
    await finishScene(page, 'furnished-scene')
  })
})
