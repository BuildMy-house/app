import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'

test.describe('layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
  })

  test('renders the full SH3D-style shell', async ({ page }) => {
    await expect(page.locator('#menu-bar')).toBeVisible()
    await expect(page.locator('#toolbar')).toBeVisible()
    await expect(page.locator('#main-area')).toBeVisible()
    await expect(page.locator('#status-bar')).toBeVisible()
    await expect(page.locator('#plan-panel')).toBeVisible()
    await expect(page.locator('#view3d-panel')).toBeVisible()
    await expect(page.locator('#divider')).toBeVisible()
  })

  test('toolbar has all tool buttons', async ({ page }) => {
    const tools = page.locator('button[data-tool]')
    await expect(tools).toHaveCount(5)
    await expect(page.locator('button[data-tool="selection"]')).toBeVisible()
    await expect(page.locator('button[data-tool="wall"]')).toBeVisible()
    await expect(page.locator('button[data-tool="room"]')).toBeVisible()
    await expect(page.locator('button[data-tool="dimensionLine"]')).toBeVisible()
    await expect(page.locator('button[data-tool="label"]')).toBeVisible()
  })

  test('camera toggle has split/plan/3d buttons', async ({ page }) => {
    await expect(page.locator('button[data-preset="split"]')).toBeVisible()
    await expect(page.locator('button[data-preset="plan"]')).toBeVisible()
    await expect(page.locator('button[data-preset="3d"]')).toBeVisible()
    await expect(page.locator('button[data-preset="split"]')).toHaveClass(/active/)
  })

  test('status bar shows default state', async ({ page }) => {
    await expect(page.locator('#status-tool')).toHaveText('selection')
    await expect(page.locator('#status-cursor')).toContainText('x:')
    await expect(page.locator('#status-zoom')).toContainText('zoom:')
    await expect(page.locator('#status-automation')).toContainText('automation:')
  })

  test('menu bar has File/Edit/View/Help', async ({ page }) => {
    const triggers = page.locator('.menu-trigger')
    await expect(triggers).toHaveCount(4)
    await expect(triggers.nth(0)).toHaveText('File')
    await expect(triggers.nth(1)).toHaveText('Edit')
    await expect(triggers.nth(2)).toHaveText('View')
    await expect(triggers.nth(3)).toHaveText('Help')
  })

  test('clicking a menu opens its dropdown', async ({ page }) => {
    await page.locator('.menu-trigger').first().click()
    const dropdown = page.locator('.menu-item.open .menu-dropdown')
    await expect(dropdown).toBeVisible()
    await expect(dropdown.locator('.menu-entry')).toHaveCount(5) // New, Save, Open, Export Plan as PNG, Export 3D View as PNG (separators are not .menu-entry)
  })

  test('clicking elsewhere closes the menu', async ({ page }) => {
    await page.locator('.menu-trigger').first().click()
    await expect(page.locator('.menu-item.open')).toBeVisible()
    await page.click('#main-area')
    await expect(page.locator('.menu-item.open')).toHaveCount(0)
  })

  test('tool switching updates active button and status bar', async ({ page }) => {
    await page.locator('button[data-tool="wall"]').click()
    await expect(page.locator('button[data-tool="wall"]')).toHaveClass(/active/)
    await expect(page.locator('#status-tool')).toHaveText('wall')
  })

  test('undo/redo buttons are disabled on empty home', async ({ page }) => {
    await expect(page.locator('#btn-undo')).toBeDisabled()
    await expect(page.locator('#btn-redo')).toBeDisabled()
  })

  test('File > Export Plan as PNG downloads a valid non-trivial PNG', async ({ page }) => {
    await page.locator('.menu-trigger').first().click()
    const entry = page.locator('.menu-item.open .menu-entry', { hasText: 'Export Plan as PNG' })
    await expect(entry).toBeVisible()
    const [download] = await Promise.all([page.waitForEvent('download'), entry.click()])
    expect(download.suggestedFilename()).toBe('plan.png')
    const file = readFileSync((await download.path())!)
    expect([...file.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(file.byteLength).toBeGreaterThan(1000)
  })

  test('File > Export 3D View as PNG downloads a valid non-trivial PNG', async ({ page }) => {
    await page.locator('.menu-trigger').first().click()
    const entry = page.locator('.menu-item.open .menu-entry', { hasText: 'Export 3D View as PNG' })
    await expect(entry).toBeVisible()
    const [download] = await Promise.all([page.waitForEvent('download'), entry.click()])
    expect(download.suggestedFilename()).toBe('3d-view.png')
    const file = readFileSync((await download.path())!)
    expect([...file.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(file.byteLength).toBeGreaterThan(1000)
  })
})
