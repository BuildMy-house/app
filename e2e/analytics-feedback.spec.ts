import { expect, test, type Page } from '@playwright/test'

interface Captured { sid: string; aid: string; events: Array<{ name: string; props?: Record<string, unknown> }> }

async function captureAnalytics(page: Page) {
  const batches: Captured[] = []
  const feedback: Array<Record<string, unknown>> = []
  await page.route('**/api/analytics/events', async (route) => {
    batches.push(route.request().postDataJSON() as Captured)
    await route.fulfill({ status: 202, contentType: 'application/json', body: '{"accepted":1}' })
  })
  await page.route('**/api/analytics/feedback', async (route) => {
    feedback.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({ status: 201, contentType: 'application/json', body: '{"ok":true}' })
  })
  const names = () => batches.flatMap((b) => b.events.map((e) => e.name))
  return { batches, feedback, names }
}

test.describe('analytics + feedback instrumentation', () => {
  test('milestone events fire from real UI actions, anonymously and once', async ({ page }) => {
    const cap = await captureAnalytics(page)
    await page.goto('/')
    await page.waitForSelector('#view3d canvas', { timeout: 10_000 })
    await page.waitForSelector('.catalog-card', { timeout: 10_000 })

    // Opening the app alone is not "3D view opened" (split layout is the default).
    await expect.poll(() => cap.names()).toEqual(expect.arrayContaining(['session_start', 'pageview']))
    expect(cap.names()).not.toContain('first_3d_view_opened')

    // First plan content
    await page.evaluate(() => (window as any).__model.addWall({ xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 7.5 }))
    await expect.poll(() => cap.names(), { timeout: 10_000 }).toContain('first_plan_created')

    // Furniture placement via the catalog
    await page.locator('.catalog-card').first().click()
    const box = (await page.locator('#plan-canvas').boundingBox())!
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55)

    // Explicit switches to 3D / split
    await page.locator('button[data-preset="3d"]').click()
    await page.locator('button[data-preset="split"]').click()

    await expect.poll(() => cap.names(), { timeout: 10_000 }).toEqual(
      expect.arrayContaining(['first_furniture_placed', 'first_3d_view_opened', 'split_view_used']),
    )
    // Milestones are once per session.
    await page.locator('button[data-preset="3d"]').click()
    await page.waitForTimeout(2500)
    const names = cap.names()
    expect(names.filter((n) => n === 'first_3d_view_opened')).toHaveLength(1)
    expect(names.filter((n) => n === 'session_start')).toHaveLength(1)

    // Anonymous: only random hex ids, no email/account fields.
    for (const b of cap.batches) {
      expect(Object.keys(b).sort()).toEqual(['aid', 'events', 'sid'])
      expect(b.sid).toMatch(/^[a-f0-9]{32}$/)
    }
  })

  test('opening the signup modal is recorded', async ({ page }) => {
    const cap = await captureAnalytics(page)
    await page.goto('/')
    await page.waitForSelector('#plan-canvas')

    await page.locator('#profile-widget').getByRole('button', { name: 'Sign Up', exact: true }).click()
    await expect(page.locator('.auth-dialog')).toBeVisible()
    await page.keyboard.press('Escape')

    await expect.poll(() => cap.batches.flatMap((b) => b.events).map((e) => e.name), { timeout: 10_000 }).toContain('signup_modal_opened')
  })

  test('feedback widget submits text + optional email tagged with session and plan counts', async ({ page }) => {
    const cap = await captureAnalytics(page)
    await page.goto('/')
    await page.waitForSelector('#plan-canvas')
    await page.evaluate(() => (window as any).__model.addWall({ xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 7.5 }))

    await page.locator('#feedback-btn').click()
    await page.locator('#feedback-message').fill('The 3D view is great')
    await page.locator('#feedback-email').fill('tester@example.com')
    await page.locator('.feedback-send').click()
    await expect(page.locator('.feedback-status')).toContainText('Thanks')

    expect(cap.feedback).toHaveLength(1)
    expect(cap.feedback[0]).toMatchObject({
      message: 'The 3D view is great',
      email: 'tester@example.com',
      state: { walls: 1, furniture: 0, rooms: 0, levels: 0 },
    })
    expect(cap.feedback[0]!.sid).toBe(cap.batches[0]!.sid)
  })
})
