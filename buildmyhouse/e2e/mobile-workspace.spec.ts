import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

test.describe('mobile workspace', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { state: 'attached' })
  })

  test('fits the phone viewport and exposes large navigation targets', async ({ page }) => {
    await expect(page.locator('#mobile-nav')).toBeVisible()
    await expect(page.locator('.mobile-nav-btn')).toHaveCount(4)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    expect(await page.locator('.mobile-nav-btn').first().evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
  })

  test('switches panels through the shared desktop camera and panel state', async ({ page }) => {
    await page.locator('[data-mobile-tab="3d"]').click()
    await expect(page.locator('#view3d-panel')).toBeVisible()
    await expect(page.locator('#plan-panel')).toBeHidden()

    await page.locator('[data-mobile-tab="furniture"]').click()
    await expect(page.locator('#catalog-host')).toBeVisible()
    await expect(page.locator('#plan-panel')).toBeVisible()

    await page.locator('[data-mobile-tab="properties"]').click()
    await expect(page.locator('#properties-panel')).toBeVisible()
  })
})
