import { expect, test } from '@playwright/test'

/**
 * Google sign-in surface + sign-in-gated actions. The server contract is
 * mocked at the network layer: GET /api/auth/providers, POST /api/auth/session,
 * GET /auth/google/start, POST /api/waitlist. The editor itself stays usable
 * signed-out — these tests assert the gates, not landing-page behaviour.
 */

/** Mock the provider probe so the "Continue with Google" button renders. */
async function mockGoogleAvailable(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/auth/providers', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ google: true }) }),
  )
}

test('anonymous visitors get the editor with no sign-in dialog', async ({ page }) => {
  await page.route('**/api/auth/session', (route) => route.fulfill({ status: 401, body: '' }))
  await mockGoogleAvailable(page)

  await page.goto('/')

  await expect(page.locator('#plan-canvas')).toBeVisible()
  await expect(page.locator('.auth-dialog')).toHaveCount(0)
})

test('Save to My Account while signed out opens the dialog with the save reason and Google button', async ({ page }) => {
  await page.route('**/api/auth/session', (route) => route.fulfill({ status: 401, body: '' }))
  await mockGoogleAvailable(page)

  await page.goto('/')
  await page.locator('.menu-trigger', { hasText: 'File' }).click()
  await page.locator('.menu-entry', { hasText: 'Save to My Account…' }).click()

  const dialog = page.locator('.auth-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.auth-reason')).toHaveText('Sign in to save your project')
  await expect(dialog.getByRole('button', { name: 'Continue with Google' })).toBeVisible()
})

test('?waitlist=1 signed out opens the dialog with the waitlist reason and a resuming Google returnTo', async ({ page }) => {
  await page.route('**/api/auth/session', (route) => route.fulfill({ status: 401, body: '' }))
  await mockGoogleAvailable(page)
  let started: string | undefined
  await page.route('**/auth/google/start*', async (route) => {
    started = route.request().url()
    await route.fulfill({ status: 200, contentType: 'text/html', body: 'google' })
  })

  await page.goto('/?waitlist=1')

  const dialog = page.locator('.auth-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.auth-reason')).toHaveText('Sign in to join the render-credits waitlist')
  // The deep-link param is stripped from the address bar (editor keeps its URL).
  await expect.poll(() => new URL(page.url()).searchParams.has('waitlist')).toBe(false)

  await dialog.getByRole('button', { name: 'Continue with Google' }).click()
  await expect.poll(() => started).toContain(`returnTo=${encodeURIComponent('/?waitlist=1')}`)
})

test('?waitlist=1 with a cookie session joins automatically with the bearer token and shows the toast', async ({ page }) => {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ token: 'cookie-token', user: { id: 'u1', email: 'ada@example.com', name: 'Ada', picture: null } }),
    }),
  )
  await mockGoogleAvailable(page)
  let joinAuth: string | undefined
  await page.route('**/api/waitlist', async (route) => {
    joinAuth = route.request().headers()['authorization']
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ joined: true, alreadyJoined: false, createdAt: '2026-10-18T00:00:00Z' }),
    })
  })

  await page.goto('/?waitlist=1')

  await expect(page.locator('.auth-dialog')).toHaveCount(0)
  await expect.poll(() => joinAuth).toBe('Bearer cookie-token')
  await expect(page.getByText("You're on the waitlist")).toBeVisible()
})
