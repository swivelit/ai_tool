import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route } from '@playwright/test'

const now = '2026-07-15T12:00:00Z'

type MockState = {
  wallet: number
  orderFails: boolean
  threads: Array<{ id: string; title: string; archived_at: string | null; created_at: string; updated_at: string }>
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function installBackend(page: Page, initial?: Partial<MockState>) {
  const state: MockState = {
    wallet: 0,
    orderFails: false,
    threads: [{ id: 'thread-1', title: 'Tamil planning', archived_at: null, created_at: now, updated_at: now }],
    ...initial,
  }
  await page.route('https://checkout.razorpay.com/v1/checkout.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.Razorpay=function(options){this.on=function(){};this.open=function(){options.handler({razorpay_order_id:'order_test',razorpay_payment_id:'pay_test',razorpay_signature:'signed-test-fixture'})}}`,
  }))
  await page.route('**/api/web/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === '/api/web/bootstrap') return json(route, {
      user: { id: 1, name: 'E2E User', email: 'e2e@example.test', reply_language: 'en' },
      wallet: { balance_micros: state.wallet, reserved_micros: 0, available_micros: state.wallet, version: 1 },
      billing: { currency: 'INR', credit_percent: '50', razorpay_key_id: 'rzp_test_local', min_topup_paise: 1000, max_topup_paise: 50000, packages: [{ gross_amount_paise: 1000, credited_amount_micros: 5_000_000, platform_share_paise: 500 }] },
      features: { web_chat: true, prepaid_billing: true, local_models: false },
    })
    if (path === '/api/web/billing/wallet') return json(route, { balance_micros: state.wallet, reserved_micros: 0, available_micros: state.wallet, version: 2 })
    if (path === '/api/web/billing/ledger' || path === '/api/web/billing/payments') return json(route, { items: [] })
    if (path === '/api/web/billing/orders') {
      if (state.orderFails) return json(route, { detail: 'Order creation failed safely.' }, 502)
      return json(route, { key_id: 'rzp_test_local', provider_order_id: 'order_test', amount: 1000, currency: 'INR', internal_order_id: 'internal-order', credited_amount_micros: 5_000_000, platform_share_paise: 500 }, 201)
    }
    if (path === '/api/web/billing/verify') {
      state.wallet = 5_000_000
      return json(route, { status: 'credited', credited: true })
    }
    if (path === '/api/web/threads' && request.method() === 'GET') {
      const query = (url.searchParams.get('q') || '').toLowerCase()
      return json(route, { items: state.threads.filter(item => item.title.toLowerCase().includes(query)), has_more: false })
    }
    if (path === '/api/web/threads/thread-1/messages') return json(route, { items: [] })
    if (path === '/api/web/threads/thread-1' && request.method() === 'PATCH') {
      const update = request.postDataJSON() as { title?: string; archived?: boolean }
      if (update.title) state.threads[0].title = update.title
      if (update.archived) state.threads = []
      return json(route, state.threads[0] || {})
    }
    if (path === '/api/web/threads/thread-1' && request.method() === 'DELETE') {
      state.threads = []
      return route.fulfill({ status: 204, body: '' })
    }
    if (path === '/api/web/chat/stream') {
      if (state.wallet <= 0) return json(route, { error: { code: 'insufficient_credit', message: 'Add AI credit to continue.' } }, 402)
      const requestId = String((request.postDataJSON() as { request_id: string }).request_id)
      const body = [
        `event: thread\ndata: {"thread_id":"thread-1"}\n\n`,
        `event: status\ndata: {"phase":"responding"}\n\n`,
        `event: delta\ndata: {"text":"வணக்கம் — **ready**"}\n\n`,
        `event: usage\ndata: {"provider":"sarvam","model":"sarvam-30b","input_tokens":10,"output_tokens":4,"usage_source":"actual","charged_micros":1200}\n\n`,
        `event: wallet\ndata: {"balance_micros":4998800,"reserved_micros":0,"available_micros":4998800,"version":3}\n\n`,
        `event: done\ndata: {"message_id":"assistant-${requestId}","thread_id":"thread-1","cancelled":false}\n\n`,
      ].join('')
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body })
    }
    if (path.includes('/cancel')) return json(route, { status: 'stopped' })
    return json(route, { detail: `Unhandled local E2E route: ${path}` }, 500)
  })
  return state
}

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Email address').fill('e2e@example.test')
  await page.getByLabel('Password', { exact: true }).fill('local-only-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
}

test('authentication, OTP state, password visibility, and direct legal routes', async ({ page }) => {
  await page.route('**/auth/email-otp/signup/request', route => json(route, { status: 'otp_sent' }))
  await page.goto('/')
  await page.getByLabel('Email address').fill('wrong@example.test')
  await page.getByLabel('Password', { exact: true }).fill('wrong-password')
  await page.getByRole('button', { name: 'Show password' }).click()
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('incorrect')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Name').fill('Local User')
  await page.getByLabel('Email address').fill('new@example.test')
  await page.getByLabel('Password', { exact: true }).fill('local-password')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByLabel('Verification code')).toBeVisible()

  for (const [path, title] of [['/terms', 'Terms'], ['/privacy', 'Privacy'], ['/refunds', 'Refund policy']] as const) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    await expect(page.getByText('Publication content pending legal review')).toBeVisible()
  }
})

test('zero-credit block, exact allocation, Test Mode payment, streaming, search, rename, archive, and theme', async ({ page }, testInfo) => {
  const state = await installBackend(page)
  await signIn(page)
  await page.getByLabel('Message Swico').fill('hello')
  await page.getByRole('button', { name: 'Send message' }).click()
  const billingDialog = page.getByRole('dialog', { name: 'Add AI credit' })
  await expect(billingDialog).toBeVisible()
  await expect(page.getByText('Test Mode')).toBeVisible()
  await expect(billingDialog.locator('.allocation')).toContainText('AI credit ₹5')
  await expect(billingDialog.locator('.allocation')).toContainText('Platform allocation ₹5')
  await expect(page.getByText(/non-transferable, non-withdrawable/)).toBeVisible()
  await page.getByRole('button', { name: 'Pay ₹10 securely' }).click()
  await expect.poll(() => state.wallet).toBe(5_000_000)
  await expect(page.getByRole('dialog', { name: 'Add AI credit' })).toBeHidden()

  await page.getByLabel('Message Swico').fill('தமிழில் பதில்')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('வணக்கம் —')).toBeVisible()
  await expect(page.getByText(/sarvam · sarvam-30b/)).toBeAttached()

  if (testInfo.project.name === 'mobile-chromium') {
    await page.getByRole('button', { name: 'Open sidebar' }).click()
  }
  await page.getByLabel('Search chats').fill('Tamil')
  await expect(page.getByRole('button', { name: 'Tamil planning', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Actions for Tamil planning' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const rename = page.getByRole('dialog', { name: 'Rename chat' }).getByRole('textbox')
  await rename.fill('Release audit')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect.poll(() => state.threads[0]?.title).toBe('Release audit')

  await page.getByRole('button', { name: /E2E User/ }).click()
  await page.getByRole('menuitem', { name: 'Toggle theme' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
})

test('order failure is safe and primary views have no critical accessibility violations', async ({ page }, testInfo) => {
  const state = await installBackend(page)
  await signIn(page)
  if (testInfo.project.name === 'mobile-chromium') {
    await page.getByRole('button', { name: 'Open sidebar' }).click()
  }
  await page.getByRole('button', { name: /Add credit/ }).click()
  state.orderFails = true
  await page.getByRole('button', { name: 'Pay ₹10 securely' }).click()
  await expect(page.getByRole('status')).toContainText('Order creation failed safely')
  expect(state.wallet).toBe(0)
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(item => item.impact === 'critical')).toEqual([])
})

test('thread archive and confirmed delete mutate only the selected history item', async ({ page }, testInfo) => {
  const state = await installBackend(page, { wallet: 5_000_000 })
  await signIn(page)
  if (testInfo.project.name === 'mobile-chromium') await page.getByRole('button', { name: 'Open sidebar' }).click()
  await page.getByRole('button', { name: 'Actions for Tamil planning' }).click()
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  await expect.poll(() => state.threads.length).toBe(0)

  state.threads.push({ id: 'thread-1', title: 'Delete target', archived_at: null, created_at: now, updated_at: now })
  await page.reload()
  if (testInfo.project.name === 'mobile-chromium') await page.getByRole('button', { name: 'Open sidebar' }).click()
  await page.getByRole('button', { name: 'Actions for Delete target' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByRole('dialog', { name: 'Delete chat?' })).toBeVisible()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(() => state.threads.length).toBe(0)
})

test('stop generation sends cancellation and mobile drawer is operable', async ({ page }, testInfo) => {
  const state = await installBackend(page, { wallet: 5_000_000 })
  await page.route('**/api/web/chat/stream', async route => {
    await new Promise(resolve => setTimeout(resolve, 10_000))
    await route.fulfill({ status: 499, body: '' }).catch(() => undefined)
  })
  await signIn(page)
  await page.getByLabel('Message Swico').fill('long response')
  await page.getByRole('button', { name: 'Send message' }).click()
  await page.getByRole('button', { name: 'Stop generation' }).click()
  await expect(page.getByRole('alert')).toContainText(/Stopping|stopped|completed/)
  expect(state.wallet).toBe(5_000_000)
  if (testInfo.project.name === 'mobile-chromium') {
    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await expect(page.getByRole('complementary', { name: 'Chat history' })).toHaveClass(/open/)
    await page.locator('.mobile-close').click()
  }
})
