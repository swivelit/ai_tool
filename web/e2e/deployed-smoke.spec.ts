import { expect, test, type Page } from '@playwright/test'

test.skip(process.env.PLAYWRIGHT_MODE !== 'staging', 'Staging deployment only')

const email = process.env.E2E_TEST_EMAIL ?? ''
const password = process.env.E2E_TEST_PASSWORD ?? ''

async function login(page: Page) {
  expect(email, 'E2E_TEST_EMAIL must be configured').not.toBe('')
  expect(password, 'E2E_TEST_PASSWORD must be configured').not.toBe('')
  await page.goto('/')
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
}

async function openSidebarOnMobile(page: Page) {
  if (await page.getByRole('button', { name: 'Open sidebar' }).isVisible()) {
    await page.getByRole('button', { name: 'Open sidebar' }).click()
  }
}

async function openSettings(page: Page) {
  await openSidebarOnMobile(page)
  await page.locator('.account-button').click()
  await page.getByRole('menuitem', { name: 'Settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
}

test('real staging authentication, token usage, reversible settings, legal pages, theme, and logout', async ({ page }) => {
  const consoleFailures: string[] = []
  page.on('console', message => { if (message.type() === 'error') consoleFailures.push(message.text()) })
  page.on('pageerror', error => consoleFailures.push(error.name))
  await login(page)

  await openSidebarOnMobile(page)
  const tokenCard = page.getByRole('button', { name: /Token credits.*tokens|Token credits.*Estimate unavailable/i })
  await expect(tokenCard).toBeVisible()
  await expect(tokenCard).not.toContainText(/₹|\b\d+\.\d{2}\s+(?:token\s+)?credits/i)

  await openSettings(page)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.getByRole('button', { name: 'Profile' }).click()
  const nameInput = page.getByLabel('Name', { exact: true })
  const originalName = await nameInput.inputValue()
  const probeName = `${originalName.slice(0, 65)} E2E`
  try {
    await nameInput.fill(probeName)
    await page.getByRole('button', { name: 'Save profile' }).click()
    await expect(page.getByRole('status')).toContainText('Profile saved')
  } finally {
    await nameInput.fill(originalName)
    await page.getByRole('button', { name: 'Save profile' }).click()
    await expect(page.getByRole('status')).toContainText('Profile saved')
  }

  await settings.getByRole('button', { name: 'Token credits', exact:true }).click()
  await expect(settings.getByText('Current-month tokens')).toBeVisible()
  await expect(settings.getByText(/Provider-reported requests:/)).toBeVisible()
  await expect(settings.getByText(/Pricing timestamp:/)).toBeVisible()
  const unlimited = page.getByLabel('No monthly limit beyond prepaid token credits')
  const wasUnlimited = await unlimited.isChecked()
  const limitInput = page.getByLabel('Estimated monthly tokens')
  const originalLimit = wasUnlimited ? '' : await limitInput.inputValue()
  try {
    if (wasUnlimited) await unlimited.uncheck()
    await page.getByLabel('Estimated monthly tokens').fill('100000')
    await page.getByRole('button', { name: 'Save usage limit' }).click()
    await expect(page.getByRole('status')).toContainText('Monthly usage limit saved')
  } finally {
    if (wasUnlimited) await unlimited.check()
    else await page.getByLabel('Estimated monthly tokens').fill(originalLimit)
    await page.getByRole('button', { name: 'Save usage limit' }).click()
    await expect(page.getByRole('status')).toContainText('Monthly usage limit saved')
  }
  await page.getByRole('button', { name: 'Close settings' }).click()

  await page.getByLabel('Message Swico').fill('Reply with exactly: staging smoke ok')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.locator('.message.assistant').last()).toBeVisible({ timeout: 60_000 })
  const details = page.locator('.message.assistant').last().getByText('Details')
  await details.click()
  await expect(page.locator('.message.assistant').last()).toContainText(/Provider-reported usage|Estimated usage/)
  await expect(page.locator('.message.assistant').last()).not.toContainText('₹')

  await openSidebarOnMobile(page)
  await page.getByRole('button', { name: /Add tokens/ }).click()
  const billing = page.getByRole('dialog', { name: 'Add token credits' })
  await expect(billing).toContainText('Test Mode')
  await expect(billing).toContainText('50% converted to token credits')
  await expect(billing).not.toContainText(/Equivalent to ₹|\d+\.\d{2}\s+(?:token\s+)?credits/i)
  await page.getByRole('button', { name: 'Close add token credits' }).click()

  for (const route of ['terms', 'privacy', 'refunds', 'contact', 'ai', 'delivery', 'pricing']) {
    await page.goto(`/legal/${route}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  }
  await page.goto('/')
  await openSidebarOnMobile(page)
  await page.locator('.account-button').click()
  await page.getByRole('menuitem', { name: 'Toggle theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/)
  await page.locator('.account-button').click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  expect(consoleFailures.filter(item => /content security policy|mixed content|cors|uncaught|firebase.*error/i.test(item))).toEqual([])
})

test('@razorpay-test-payment isolated Test Mode payment', async ({ page }) => {
  test.skip(process.env.E2E_ALLOW_TEST_PAYMENT !== 'true', 'Set E2E_ALLOW_TEST_PAYMENT=true only for isolated staging')
  await login(page)
  await openSidebarOnMobile(page)
  await page.getByRole('button', { name: /Add tokens/ }).click()
  await expect(page.getByRole('dialog', { name: 'Add token credits' })).toContainText('Test Mode')
  test.skip(true, 'Payment completion requires an explicitly supervised staging run; this automated suite never submits payment details')
})
