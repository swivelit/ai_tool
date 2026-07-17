import { expect, test } from '@playwright/test'

test.skip(process.env.PLAYWRIGHT_MODE !== 'production-readonly', 'Production read-only deployment only')

test('production authentication and public/account read-only surfaces', async ({ page }) => {
  const email = process.env.E2E_TEST_EMAIL ?? ''
  const password = process.env.E2E_TEST_PASSWORD ?? ''
  expect(email, 'E2E_TEST_EMAIL must be configured').not.toBe('')
  expect(password, 'E2E_TEST_PASSWORD must be configured').not.toBe('')
  await page.goto('/')
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
  if (await page.getByRole('button', { name: 'Open sidebar' }).isVisible()) await page.getByRole('button', { name: 'Open sidebar' }).click()
  await expect(page.getByText('Token credits')).toBeVisible()
  await page.locator('.account-button').click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await page.getByRole('dialog', { name:'Settings' }).getByRole('button', { name: 'Token credits', exact:true }).click()
  await expect(page.getByText('Current-month tokens')).toBeVisible()
  await page.getByRole('button', { name: 'Close settings' }).click()
  for (const route of ['terms', 'privacy', 'refunds', 'contact', 'ai', 'delivery', 'pricing']) {
    await page.goto(`/legal/${route}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  }
})
