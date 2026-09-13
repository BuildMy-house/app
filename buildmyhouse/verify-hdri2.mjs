import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()))
page.on('pageerror', (err) => console.log('[pageerror]', err.message))
await page.goto('http://localhost:1428/')
await page.waitForTimeout(1000)
// Click the "3D" toolbar button for a full 3D view
await page.locator('button:has-text("3D")').first().click()
await page.waitForTimeout(3000)
await page.screenshot({ path: '/tmp/hdri-3d-full.png' })

// Open the View menu (top menu bar item, not toolbar)
await page.locator('#app >> text=View').first().click({ timeout: 5000 }).catch(async (e) => {
  console.log('direct click failed, trying menu bar role')
})
await page.waitForTimeout(500)
await page.screenshot({ path: '/tmp/hdri-menu-open2.png' })
await browser.close()
console.log('done')
