import { expect, test, type Page } from '@playwright/test'
import { productionRequestViolation } from '../src/testing/deployedSafety'

test.skip(process.env.PLAYWRIGHT_MODE !== 'production-readonly', 'Production read-only deployment only')

const email = process.env.E2E_TEST_EMAIL ?? ''
const password = process.env.E2E_TEST_PASSWORD ?? ''

async function openSidebarOnMobile(page: Page) {
  const trigger = page.getByRole('button', { name:'Open sidebar' })
  if (await trigger.isVisible()) await trigger.click()
}

async function logout(page: Page) {
  await page.goto('/')
  await openSidebarOnMobile(page)
  await page.locator('.account-button').click()
  await page.getByRole('menuitem', { name:'Sign out' }).click()
  await expect(page.getByRole('heading', { name:'Welcome back' })).toBeVisible()
}

test('production authentication and public/account surfaces remain read-only', async ({ page }) => {
  if (!email) throw new Error('E2E_TEST_EMAIL must be configured')
  if (!password) throw new Error('E2E_TEST_PASSWORD must be configured')
  const requestViolations: string[] = []
  const browserFailures: string[] = []

  page.on('request', request => {
    const violation = productionRequestViolation(request.url(), request.method())
    if (violation) requestViolations.push(violation)
  })
  page.on('console', message => {
    const content = message.text()
    if (/content security policy|\bcsp\b|\bcors\b|mixed content/i.test(content)) {
      browserFailures.push(`browser security error: ${content}`)
      return
    }
    if (message.type() !== 'error') return
    // Chromium can emit this harmless layout diagnostic without application failure.
    if (/^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/.test(content)) return
    browserFailures.push(`console error: ${content}`)
  })
  page.on('pageerror', error => browserFailures.push(`page error: ${error.name}: ${error.message}`))

  try {
    await page.goto('/')
    await page.getByLabel('Email address').fill(email)
    await page.getByLabel('Password', { exact:true }).fill(password)
    const bootstrapResponse = page.waitForResponse(response => {
      try { return new URL(response.url()).pathname === '/api/web/bootstrap' }
      catch { return false }
    })
    await page.getByRole('button', { name:'Sign in' }).click()
    const bootstrap = await bootstrapResponse
    const publicConfigUrl = new URL('/api/web/billing/public-config', bootstrap.url()).toString()
    const publicBilling = await page.evaluate(async url => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`public billing config failed (${response.status})`)
      return response.json() as Promise<{ razorpay_mode: string; checkout_enabled: boolean }>
    }, publicConfigUrl)
    expect(publicBilling.razorpay_mode).toBe('test')
    expect(publicBilling.checkout_enabled).toBe(false)
    await expect(page.getByRole('button', { name:'Send message' })).toBeVisible()
    await openSidebarOnMobile(page)
    const tokenCard = page.getByRole('button', { name:/Token credits.*tokens|Token credits.*Estimate unavailable/i })
    await expect(tokenCard).toBeVisible()
    await expect(tokenCard).not.toContainText(/₹|\bAI credits?\b|\b\d+\.\d{2}\s+(?:token\s+)?credits/i)
    await page.locator('.account-button').click()
    await page.getByRole('menuitem', { name:'Settings' }).click()
    const settings = page.getByRole('dialog', { name:'Settings' })
    await settings.getByRole('button', { name:'Token credits', exact:true }).click()
    await expect(settings.getByText('Current-month tokens')).toBeVisible()
    await expect(settings.getByText(/Provider-reported requests:/)).toBeVisible()
    await expect(settings.locator('.settings-history article > strong').filter({ hasText:/₹.*\bpaid\b/i })).toHaveCount(0)
    await expect(settings).not.toContainText(/cash balance|credited balance/i)
    await page.getByRole('button', { name:'Close settings' }).click()
    for (const route of ['terms', 'privacy', 'refunds', 'contact', 'ai', 'delivery', 'pricing']) {
      await page.goto(`/legal/${route}`)
      await expect(page.getByRole('heading', { level:1 })).toBeVisible()
    }
  } finally {
    let logoutFailed = false
    try { await logout(page) } catch { logoutFailed = true }
    expect(requestViolations, 'Production-readonly must never mutate Swico or reach checkout/chat endpoints').toEqual([])
    expect(browserFailures, 'Production-readonly must have no unapproved browser errors').toEqual([])
    expect(logoutFailed, 'Production-readonly cleanup must log out while the application is reachable').toBe(false)
  }
})
