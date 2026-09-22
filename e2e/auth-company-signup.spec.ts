import { expect, test } from '@playwright/test'

test('company signup sends company details and authenticates the new owner', async ({ page }) => {
  let registration: Record<string, unknown> | undefined
  await page.route('**/api/auth/register', async (route) => {
    registration = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ token: 'test-token' }) })
  })
  await page.goto('/')

  await page.locator('#profile-widget').getByRole('button', { name: /Sign Up to Save/ }).click()
  await page.getByRole('button', { name: 'Sign Up', exact: true }).click()
  await page.getByLabel('Company', { exact: true }).check()
  await page.getByLabel('Company name').fill('Acme Design')
  await page.getByLabel('Email').fill('owner@example.com')
  await page.getByLabel('Password', { exact: true }).fill('secure-password')
  await page.getByLabel('Confirm password').fill('secure-password')
  await page.getByRole('button', { name: 'Create Company Account' }).click()

  await expect.poll(() => registration).toEqual({
    email: 'owner@example.com',
    password: 'secure-password',
    companyName: 'Acme Design',
  })
  await expect(page.locator('.auth-dialog')).toHaveCount(0)
  await expect(page.locator('#profile-widget')).toContainText('owner@example.com')
})
