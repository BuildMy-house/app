import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { expect, test } from '@playwright/test'

// Real bundled GLB; slicing it mid-body yields a valid 12-byte "glTF" header
// with a truncated JSON chunk — the case pure magic-byte checks cannot catch.
const deskGlb = readFileSync('public/assets/models/desk.glb')
const truncatedGlb = deskGlb.subarray(0, 300)

// Playwright refuses in-memory buffers >50MB, so the oversized-file case uses
// a real 512MB file on disk. The app must reject it on file.size without
// ever reading the bytes.
const hugeGlbPath = '/tmp/opencode/huge-512mb.glb'
writeFileSync(hugeGlbPath, Buffer.alloc(512 * 1024 * 1024, 7))

test.afterAll(() => {
  rmSync(hugeGlbPath, { force: true })
})

type Page = import('@playwright/test').Page

/** Collect uncaught page errors (expected failures are console.error'd, not thrown). */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e}`))
  return errors
}

async function importBuffer(page: Page, name: string, buffer: Buffer): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.catalog-import').click(),
  ])
  await chooser.setFiles({ name, mimeType: 'model/gltf-binary', buffer })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.catalog-import')).toBeVisible({ timeout: 10_000 })
})

test('text file renamed .glb is rejected with a clear message', async ({ page }) => {
  const errors = trackPageErrors(page)
  const before = await page.locator('.catalog-card').count()

  await importBuffer(page, 'fake.glb', Buffer.from('definitely not a glb - just plain text'))

  await expect(page.locator('.catalog-status')).toContainText('not a GLB')
  await expect(page.locator('#status-automation')).toHaveText('import failed')
  await expect(page.locator('.catalog-card')).toHaveCount(before)
  expect(errors).toEqual([])
})

test('truncated GLB is rejected instead of joining the catalog', async ({ page }) => {
  const errors = trackPageErrors(page)
  const before = await page.locator('.catalog-card').count()

  await importBuffer(page, 'truncated.glb', Buffer.from(truncatedGlb))

  await expect(page.locator('.catalog-status')).toContainText('corrupted or truncated')
  await expect(page.locator('#status-automation')).toHaveText('import failed')
  await expect(page.locator('.catalog-card')).toHaveCount(before)
  expect(errors).toEqual([])
})

test('512MB file is rejected fast, without reading the bytes', async ({ page }) => {
  const errors = trackPageErrors(page)
  const before = await page.locator('.catalog-card').count()

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.catalog-import').click(),
  ])
  await chooser.setFiles(hugeGlbPath)

  // If the app regressed to reading the file first, this would take ~8s+.
  await expect(page.locator('.catalog-status')).toContainText('import limit is 50 MB', {
    timeout: 5_000,
  })
  await expect(page.locator('#status-automation')).toHaveText('import failed')
  await expect(page.locator('.catalog-card')).toHaveCount(before)
  expect(errors).toEqual([])
})

test('valid GLB still imports successfully', async ({ page }) => {
  const errors = trackPageErrors(page)
  const before = await page.locator('.catalog-card').count()

  await importBuffer(page, 'desk.glb', deskGlb)

  await expect(page.locator('#status-automation')).toHaveText('imported desk')
  await expect(page.locator('.catalog-card')).toHaveCount(before + 1)
  expect(errors).toEqual([])
})
