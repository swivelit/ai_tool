import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import {
  assertUsableTokenCredits, deleteGeneratedThread, restoreProfile, restoreUsagePreferences,
  type ApiResult, type DeployedApi, type RestorableProfile, type RestorableUsagePreferences,
} from '../src/testing/deployedSafety'

test.skip(process.env.PLAYWRIGHT_MODE !== 'staging', 'Staging deployment only')

const email = process.env.E2E_TEST_EMAIL ?? ''
const password = process.env.E2E_TEST_PASSWORD ?? ''

type Bootstrap = { wallet: { available_micros: number }; billing: { razorpay_mode: string } }
type Thread = { id: string; title: string }
type UsagePreferencesSnapshot = RestorableUsagePreferences & Record<string, unknown>

class AuthenticatedApi implements DeployedApi {
  constructor(
    private readonly requestContext: APIRequestContext,
    private readonly origin: string,
    private readonly authorization: string,
  ) {}

  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>> {
    const response = await this.requestContext.fetch(`${this.origin}${path}`, {
      method,
      headers: { Authorization: this.authorization, Accept: 'application/json' },
      ...(body === undefined ? {} : { data: body }),
    })
    const contentType = response.headers()['content-type'] ?? ''
    const data = contentType.includes('application/json') ? await response.json() as T : null
    return { status: response.status(), data }
  }
}

function installBrowserFailureGuard(page: Page) {
  const failures: string[] = []
  page.on('console', message => {
    const content = message.text()
    if (/content security policy|\bcsp\b|\bcors\b|mixed content/i.test(content)) {
      failures.push(`browser security error: ${content}`)
      return
    }
    if (message.type() !== 'error') return
    // Chromium can emit this harmless layout diagnostic without application failure.
    if (/^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)/.test(content)) return
    failures.push(`console error: ${content}`)
  })
  page.on('pageerror', error => failures.push(`page error: ${error.name}: ${error.message}`))
  page.on('requestfailed', request => {
    const reason = request.failure()?.errorText ?? 'unknown request failure'
    // Intentional page navigation can cancel the previous document request.
    if (reason === 'net::ERR_ABORTED' && request.resourceType() === 'document') return
    failures.push(`request failure: ${reason}`)
  })
  return () => expect(failures, 'No unapproved console, page, CSP, CORS, mixed-content, or request errors').toEqual([])
}

async function login(page: Page): Promise<{ api: AuthenticatedApi; bootstrap: Bootstrap }> {
  if (!email) throw new Error('E2E_TEST_EMAIL must be configured')
  if (!password) throw new Error('E2E_TEST_PASSWORD must be configured')
  await page.goto('/')
  const bootstrapResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/web/bootstrap' && response.status() === 200)
  await page.getByLabel('Email address').fill(email)
  await page.getByLabel('Password', { exact:true }).fill(password)
  await page.getByRole('button', { name:'Sign in' }).click()
  const response = await bootstrapResponse
  await expect(page.getByRole('button', { name:'Send message' })).toBeVisible()
  const headers = await response.request().allHeaders()
  const authorization = headers.authorization
  if (!authorization?.startsWith('Bearer ')) throw new Error('Authenticated Swico API request was not observed')
  return {
    api: new AuthenticatedApi(page.request, new URL(response.url()).origin, authorization),
    bootstrap: await response.json() as Bootstrap,
  }
}

async function openSidebarOnMobile(page: Page) {
  const trigger = page.getByRole('button', { name:'Open sidebar' })
  if (await trigger.isVisible()) await trigger.click()
}

async function openSettings(page: Page) {
  await openSidebarOnMobile(page)
  await page.locator('.account-button').click()
  await page.getByRole('menuitem', { name:'Settings' }).click()
  await expect(page.getByRole('dialog', { name:'Settings' })).toBeVisible()
}

async function attemptLogout(page: Page) {
  if (page.isClosed()) return
  try {
    await page.goto('/')
    const send = page.getByRole('button', { name:'Send message' })
    if (!await send.isVisible()) return
    await openSidebarOnMobile(page)
    await page.locator('.account-button').click()
    await page.getByRole('menuitem', { name:'Sign out' }).click()
    await expect(page.getByRole('heading', { name:'Welcome back' })).toBeVisible()
  } catch {
    // Cleanup still restores server state through authenticated API calls first.
  }
}

test('real staging authentication, reversible mutations, token usage, Test Mode, legal pages, and logout', async ({ page }) => {
  const assertNoBrowserFailures = installBrowserFailureGuard(page)
  let api: AuthenticatedApi | null = null
  let originalProfile: RestorableProfile | null = null
  let originalUsage: UsagePreferencesSnapshot | null = null
  let generatedThreadId: string | null = null
  let originalThreadIds = new Set<string>()
  const runMarker = `swico-e2e-${Date.now()}-${test.info().project.name}`

  try {
    const authenticated = await login(page)
    api = authenticated.api
    assertUsableTokenCredits(authenticated.bootstrap.wallet.available_micros)
    expect(authenticated.bootstrap.billing.razorpay_mode, 'Staging must use Razorpay Test Mode').toBe('test')

    const profileResponse = await api.request<RestorableProfile>('GET', '/api/web/settings/profile')
    // Keep the complete response as the immutable snapshot; cleanup sends and
    // verifies every mutable preference field from it.
    const usageResponse = await api.request<UsagePreferencesSnapshot>('GET', '/api/web/settings/usage')
    const threadsResponse = await api.request<{ items: Thread[] }>('GET', '/api/web/threads?archived=false&limit=100&offset=0')
    expect(profileResponse.status).toBe(200); expect(usageResponse.status).toBe(200); expect(threadsResponse.status).toBe(200)
    if (!profileResponse.data || !usageResponse.data || !threadsResponse.data) throw new Error('Staging state snapshot failed')
    originalProfile = profileResponse.data
    originalUsage = usageResponse.data
    originalThreadIds = new Set(threadsResponse.data.items.map(thread => thread.id))

    await openSettings(page)
    const settings = page.getByRole('dialog', { name:'Settings' })
    await settings.getByRole('button', { name:'Profile' }).click()
    await page.getByLabel('Name', { exact:true }).fill(runMarker.slice(0, 80))
    await page.getByRole('button', { name:'Save profile' }).click()
    await expect(page.getByRole('status')).toContainText('Profile saved')
    const changedProfile = await api.request<RestorableProfile>('GET', '/api/web/settings/profile')
    expect(changedProfile.data?.name).toBe(runMarker.slice(0, 80))

    await settings.getByRole('button', { name:'Token credits', exact:true }).click()
    await expect(settings.getByText('This month')).toBeVisible()
    await expect(settings).not.toContainText(/Measured requests|Estimated requests|Pricing timestamp|Estimated for Swico/i)
    await page.getByLabel('No monthly limit beyond prepaid token credits').check()
    const changedThreshold = originalUsage.warning_threshold_percent === 99 ? 98 : 99
    await page.getByLabel('Warning threshold (%)').fill(String(changedThreshold))
    const notify = page.getByLabel('Show a warning at the threshold')
    if (originalUsage.notify_at_threshold) await notify.uncheck(); else await notify.check()
    await page.getByRole('button', { name:'Save usage limit' }).click()
    await expect(page.getByRole('status')).toContainText('Monthly usage limit saved')
    const changedUsage = await api.request<RestorableUsagePreferences>('GET', '/api/web/settings/usage')
    expect(changedUsage.data).toMatchObject({
      hard_limit_micros:null,
      warning_threshold_percent:changedThreshold,
      notify_at_threshold:!originalUsage.notify_at_threshold,
    })
    await page.getByRole('button', { name:'Close settings' }).click()

    const created = await api.request<Thread>('POST', '/api/web/threads', { title:runMarker })
    expect(created.status).toBe(201)
    if (!created.data || originalThreadIds.has(created.data.id) || created.data.title !== runMarker) {
      throw new Error('Could not bind cleanup to a unique E2E thread')
    }
    generatedThreadId = created.data.id
    await page.reload()
    await expect(page.getByRole('button', { name:'Send message' })).toBeVisible()
    await openSidebarOnMobile(page)
    await page.getByRole('button', { name:runMarker, exact:true }).click()
    await page.getByLabel('Message Swico').fill(`Reply OK. ${runMarker}`)
    await page.getByRole('button', { name:'Send message' }).click()
    const assistant = page.locator('.message.assistant').last()
    await expect(assistant).toBeVisible({ timeout:60_000 })
    await assistant.getByText('Details').click()
    await expect(assistant).toContainText(/Provider-reported usage|Estimated usage/)
    await expect(assistant).not.toContainText('₹')

    await openSidebarOnMobile(page)
    const tokenCard = page.getByRole('button', { name:/Token credits.*tokens|Token credits.*Estimate unavailable/i })
    await expect(tokenCard).toBeVisible()
    await expect(tokenCard).not.toContainText(/₹|\b\d+\.\d{2}\s+(?:token\s+)?credits/i)
    await page.getByRole('button', { name:/Add tokens/ }).click()
    const billing = page.getByRole('dialog', { name:'Add token credits' })
    await expect(billing.getByText('Test Mode', { exact:true })).toBeVisible()
    await expect(billing).toContainText('50% converted to token credits')
    await expect(billing).not.toContainText(/Equivalent to ₹|\d+\.\d{2}\s+(?:token\s+)?credits/i)
    await page.getByRole('button', { name:'Close add token credits' }).click()

    for (const route of ['terms', 'privacy', 'refunds', 'contact', 'ai', 'delivery', 'pricing']) {
      await page.goto(`/legal/${route}`)
      await expect(page.getByRole('heading', { level:1 })).toBeVisible()
    }
  } finally {
    const cleanupErrors: string[] = []
    if (api && generatedThreadId) {
      try { await deleteGeneratedThread(api, generatedThreadId, originalThreadIds) }
      catch (error) { cleanupErrors.push(error instanceof Error ? error.message : 'thread cleanup failed') }
    }
    if (api && originalUsage) {
      try { await restoreUsagePreferences(api, originalUsage) }
      catch (error) { cleanupErrors.push(error instanceof Error ? error.message : 'usage cleanup failed') }
    }
    if (api && originalProfile) {
      try { await restoreProfile(api, originalProfile) }
      catch (error) { cleanupErrors.push(error instanceof Error ? error.message : 'profile cleanup failed') }
    }
    await attemptLogout(page)
    assertNoBrowserFailures()
    expect(cleanupErrors, 'Every staging mutation must be restored and verified').toEqual([])
  }
})
