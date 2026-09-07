import { test, expect } from '@playwright/test'

const VIEWPORT_WIDTHS = [1280, 1600, 1920]

const LONG_LABEL_SAMPLES = [
  'Chest',
  'Round table',
  'Washbasin',
  'Bed 90x190',
  'Washbasin with cabinet',
]

test.describe('catalog panel label clipping', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
    await page.waitForSelector('.catalog-card', { timeout: 10_000 })
  })

  for (const width of VIEWPORT_WIDTHS) {
    test(`labels do not clip at ${width}px viewport`, async ({ page }) => {
      const height = 900
      await page.setViewportSize({ width, height })

      // Ensure the catalog host is visible and at its default width.
      const host = page.locator('#catalog-host')
      await expect(host).toBeVisible()

      // Collect every catalog card label and assert it is not horizontally
      // clipped (scrollWidth must fit within clientWidth).
      const clipped = await page.evaluate((samples) => {
        const cards = Array.from(document.querySelectorAll('.catalog-card'))
        const results: string[] = []
        for (const sample of samples) {
          const card = cards.find((c) => {
            const nameEl = c.querySelector('.catalog-name')
            return nameEl?.textContent?.trim().includes(sample)
          })
          if (!card) {
            results.push(`missing: ${sample}`)
            continue
          }
          const nameEl = card.querySelector('.catalog-name') as HTMLElement
          const dimsEl = card.querySelector('.catalog-dims') as HTMLElement | null
          for (const el of [nameEl, dimsEl]) {
            if (!el) continue
            if (el.scrollWidth > el.clientWidth) {
              results.push(`${sample}: ${el.className} scrollWidth=${el.scrollWidth} clientWidth=${el.clientWidth}`)
            }
          }
        }
        return results
      }, LONG_LABEL_SAMPLES)

      expect(clipped, `clipped labels at ${width}px: ${clipped.join('; ')}`).toEqual([])
    })
  }

  test('catalog panel has a resize handle', async ({ page }) => {
    const handle = page.locator('.catalog-resize-handle')
    await expect(handle).toBeVisible()
  })
})
