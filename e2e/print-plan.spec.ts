import { test, expect } from '@playwright/test'

test.describe('print plan', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  })

  test('File menu contains Print Plan entry', async ({ page }) => {
    await page.locator('.menu-trigger').first().click()
    const entry = page.locator('.menu-item.open .menu-entry', { hasText: 'Print Plan' })
    await expect(entry).toBeVisible()
  })

  test('print layout hides chrome and shows plan image', async ({ page }) => {
    // Populate print container without opening the system print dialog
    await page.evaluate(() => {
      const original = window.print
      window.print = () => {}
      ;(window as unknown as { __printPlan: () => void }).__printPlan()
      window.print = original
    })

    await page.emulateMedia({ media: 'print' })

    const img = page.locator('#print-plan img')
    await expect(img).toBeVisible()
    await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)

    for (const selector of [
      '#menu-bar',
      '#toolbar',
      '#catalog-host',
      '#properties-panel',
      '#status-bar',
      '#divider',
      '#view3d-panel',
      '#plan-panel',
    ]) {
      const el = page.locator(selector)
      if ((await el.count()) === 0) continue
      await expect(el).not.toBeVisible()
    }

    await expect(page.locator('#print-plan')).toBeVisible()

    // Restore screen media so subsequent tests are unaffected
    await page.emulateMedia({ media: 'screen' })
  })
})
