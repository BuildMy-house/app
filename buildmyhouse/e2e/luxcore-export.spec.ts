import { test, expect } from '@playwright/test'

const SCENE_KEYS = ['version', 'name', 'textures', 'materials', 'objects', 'camera', 'lights', 'backgroundColor']

test.describe('Export Scene for LuxCore Render', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  })

  test('File menu contains Export Scene for LuxCore Render entry', async ({ page }) => {
    await page.locator('.menu-trigger').first().click()
    const entry = page.locator('.menu-item.open .menu-entry', { hasText: 'Export Scene for LuxCore Render' })
    await expect(entry).toBeVisible()
  })

  test('downloads valid JSON matching RenderableScene shape', async ({ page }) => {
    // Draw a wall so the scene is non-trivial
    await page.locator('button[data-tool="wall"]').click()
    const planCanvas = page.locator('#plan-canvas')
    const box = await planCanvas.boundingBox()
    expect(box).not.toBeNull()
    const y = box!.y + box!.height * 0.5
    await page.mouse.click(box!.x + box!.width * 0.3, y)
    await page.mouse.click(box!.x + box!.width * 0.7, y)
    await page.keyboard.press('Escape')

    // Intercept the download
    const downloadPromise = page.waitForEvent('download')
    await page.evaluate(() => {
      ;(window as unknown as { __exportSceneJson: () => void }).__exportSceneJson()
    })
    const download = await downloadPromise

    expect(download.suggestedFilename()).toBe('scene.json')

    // Read the downloaded content
    const path = await download.path()
    expect(path).not.toBeNull()
    const fs = await import('node:fs/promises')
    const content = await fs.readFile(path!, 'utf-8')
    const scene = JSON.parse(content)

    // Verify top-level shape matches RenderableScene
    for (const key of SCENE_KEYS) {
      expect(scene).toHaveProperty(key)
    }
    expect(scene.version).toBe(1)
    expect(Array.isArray(scene.materials)).toBe(true)
    expect(Array.isArray(scene.objects)).toBe(true)
    expect(Array.isArray(scene.lights)).toBe(true)
    expect(scene.camera).toHaveProperty('position')
    expect(scene.camera).toHaveProperty('yaw')
    expect(scene.camera).toHaveProperty('pitch')
    expect(scene.camera).toHaveProperty('fov')
  })
})
