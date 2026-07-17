import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route } from '@playwright/test'

const now = '2026-07-15T12:00:00Z'

type MockState = {
  wallet: number
  orderFails: boolean
  monthlyUsed: number
  hardLimit: number | null
  warningThreshold: number
  profile: { name: string; place: string | null; timezone: string; assistant_name: string; reply_language: 'en' | 'ta'; email: string; email_editable: false }
  payments: Array<{ id: string; gross_amount_paise: number; credited_amount_micros: number; platform_share_paise: number; refunded_amount_paise: number; credit_reversal_micros: number; status: string; created_at: string }>
  threads: Array<{ id: string; title: string; archived_at: string | null; created_at: string; updated_at: string }>
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function installBackend(page: Page, initial?: Partial<MockState>) {
  const state: MockState = {
    wallet: 0,
    orderFails: false,
    monthlyUsed: 0,
    hardLimit: null,
    warningThreshold: 80,
    profile: { name: 'E2E User', place: 'Chennai', timezone: 'Asia/Kolkata', assistant_name: 'Elli', reply_language: 'en', email: 'e2e@example.test', email_editable: false },
    payments: [],
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
      user: { id: 1, name: state.profile.name, email: state.profile.email, reply_language: state.profile.reply_language },
      wallet: { balance_micros: state.wallet, reserved_micros: 0, available_micros: state.wallet, version: 1 },
      billing: { currency: 'INR', credit_percent: '50', razorpay_key_id: 'rzp_test_local', razorpay_mode: 'test', checkout_enabled: true, min_topup_paise: 1000, max_topup_paise: 50000, packages: [{ gross_amount_paise: 1000, credited_amount_micros: 5_000_000, platform_share_paise: 500 }] },
      features: { web_chat: true, prepaid_billing: true, local_models: false },
    })
    if (path === '/api/web/billing/wallet') return json(route, { balance_micros: state.wallet, reserved_micros: 0, available_micros: state.wallet, version: 2 })
    if (path === '/api/web/billing/ledger') return json(route, { items: [] })
    if (path === '/api/web/billing/payments') return json(route, { items: state.payments })
    if (path === '/api/web/settings/profile' && request.method() === 'GET') return json(route, state.profile)
    if (path === '/api/web/settings/profile' && request.method() === 'PATCH') {
      state.profile = { ...state.profile, ...(request.postDataJSON() as Partial<MockState['profile']>) }
      return json(route, state.profile)
    }
    if (path === '/api/web/settings/usage' && request.method() === 'GET') return json(route, {
      period: 'monthly', hard_limit_micros: state.hardLimit,
      hard_limit_ai_credits: state.hardLimit === null ? null : String(state.hardLimit / 1_000_000),
      warning_threshold_percent: state.warningThreshold, notify_at_threshold: true,
      current_usage_micros: state.monthlyUsed, current_usage_ai_credits: String(state.monthlyUsed / 1_000_000),
      remaining_micros: state.hardLimit === null ? null : Math.max(0, state.hardLimit - state.monthlyUsed),
      warning_reached: state.hardLimit !== null && state.monthlyUsed * 100 >= state.hardLimit * state.warningThreshold,
      next_reset_at: '2026-08-01T00:00:00Z', timezone: state.profile.timezone, updated_at: now,
    })
    if (path === '/api/web/settings/usage' && request.method() === 'PATCH') {
      const update = request.postDataJSON() as { hard_limit_micros: number | null; warning_threshold_percent: number }
      state.hardLimit = update.hard_limit_micros; state.warningThreshold = update.warning_threshold_percent
      return json(route, { period:'monthly', hard_limit_micros:state.hardLimit, hard_limit_ai_credits:null, warning_threshold_percent:state.warningThreshold, notify_at_threshold:true, current_usage_micros:state.monthlyUsed, current_usage_ai_credits:String(state.monthlyUsed / 1_000_000), remaining_micros:state.hardLimit === null ? null : Math.max(0, state.hardLimit - state.monthlyUsed), warning_reached:state.hardLimit !== null && state.monthlyUsed * 100 >= state.hardLimit * state.warningThreshold, next_reset_at:'2026-08-01T00:00:00Z', timezone:state.profile.timezone, updated_at:now })
    }
    if (path === '/api/web/usage/summary') return json(route, {
      period:'current_month', timezone:state.profile.timezone, period_start:'2026-07-01T00:00:00Z', period_end:'2026-08-01T00:00:00Z', next_reset_at:'2026-08-01T00:00:00Z', request_count:state.monthlyUsed ? 1 : 0,
      input_tokens:10, cached_input_tokens:2, output_tokens:4, total_tokens:14, actual_usage_count:state.monthlyUsed ? 1 : 0, estimated_usage_count:0,
      debited_micros:state.monthlyUsed, debited_ai_credits:String(state.monthlyUsed / 1_000_000), available_micros:state.wallet, available_ai_credits:String(state.wallet / 1_000_000), daily:[], provider_breakdown:[], model_breakdown:[],
      estimated_tokens_remaining:{ reference_provider:'openai', reference_model:'gpt-5-nano', pricing_as_of:now, pricing_snapshot:{}, estimated_input_only_tokens:180000, estimated_output_only_tokens:25000, estimated_blended_tokens:60000, range_min_tokens:25000, range_max_tokens:180000, explanation:'Estimate only. Actual tokens vary by model and input/output mix.' },
    })
    if (path === '/api/web/billing/orders') {
      if (state.orderFails) return json(route, { detail: 'Order creation failed safely.' }, 502)
      return json(route, { key_id: 'rzp_test_local', provider_order_id: 'order_test', amount: 1000, currency: 'INR', internal_order_id: 'internal-order', credited_amount_micros: 5_000_000, platform_share_paise: 500 }, 201)
    }
    if (path === '/api/web/billing/verify') {
      state.wallet = 5_000_000
      state.payments = [{ id:'internal-order', gross_amount_paise:1000, credited_amount_micros:5_000_000, platform_share_paise:500, refunded_amount_paise:0, credit_reversal_micros:0, status:'credited', created_at:now }]
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
      if (state.hardLimit !== null && state.monthlyUsed + 1200 > state.hardLimit) return json(route, { error: { code:'usage_limit_reached', message:'Your monthly AI usage limit has been reached.', current_usage_micros:state.monthlyUsed, configured_limit_micros:state.hardLimit, remaining_micros:Math.max(0, state.hardLimit - state.monthlyUsed), reset_at:'2026-08-01T00:00:00Z' } }, 402)
      state.monthlyUsed += 1200
      state.wallet -= 1200
      const requestId = String((request.postDataJSON() as { request_id: string }).request_id)
      const body = [
        `event: thread\ndata: {"thread_id":"thread-1"}\n\n`,
        `event: status\ndata: {"phase":"responding"}\n\n`,
        `event: delta\ndata: {"text":"வணக்கம் — **ready**"}\n\n`,
        `event: usage\ndata: {"provider":"sarvam","model":"sarvam-30b","input_tokens":10,"output_tokens":4,"usage_source":"actual","charged_micros":1200}\n\n`,
        `event: wallet\ndata: {"balance_micros":${state.wallet},"reserved_micros":0,"available_micros":${state.wallet},"version":3}\n\n`,
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
  const billingDialog = page.getByRole('dialog', { name: 'Add AI credits' })
  await expect(billingDialog).toBeVisible()
  await expect(page.getByText('Test Mode')).toBeVisible()
  await expect(billingDialog.locator('.allocation')).toContainText('Pay ₹10 → receive 5.00 AI credits')
  await expect(billingDialog.locator('.allocation')).toContainText('Platform allocation ₹5.00')
  await expect(billingDialog).toContainText('Equivalent to ₹5 of consumable AI usage')
  await expect(page.getByText(/non-transferable, non-withdrawable/)).toBeVisible()
  await page.getByRole('button', { name: 'Pay ₹10 securely' }).click()
  await expect.poll(() => state.wallet).toBe(5_000_000)
  await expect(page.getByRole('dialog', { name: 'Add AI credits' })).toBeHidden()
  await expect(page.getByText('5.00 AI credits')).toBeVisible()

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

test('settings persist profile, disclose usage estimates, enforce a monthly cap, and expose legal controls', async ({ page }, testInfo) => {
  const state = await installBackend(page, { wallet: 5_000_000 })
  await signIn(page)
  if (testInfo.project.name === 'mobile-chromium') await page.getByRole('button', { name:'Open sidebar' }).click()
  await page.getByRole('button', { name:/E2E User/ }).click()
  await page.getByRole('menuitem', { name:'Settings' }).click()
  const settings = page.getByRole('dialog', { name:'Settings' })
  await expect(settings).toBeVisible()
  await expect(page.getByRole('button', { name:'Close settings' })).toBeFocused()
  await page.getByRole('button', { name:'Profile' }).click()
  await page.getByLabel('Name', { exact:true }).fill('E2E தமிழர்')
  await page.getByLabel('Assistant name', { exact:true }).fill('கவி')
  await settings.getByRole('combobox', { name:'Reply language', exact:true }).selectOption('ta')
  await page.getByRole('button', { name:'Save profile' }).click()
  await expect(page.getByRole('status')).toContainText('Profile saved')
  await page.getByRole('button', { name:'Close settings' }).click()
  await page.reload()
  if (testInfo.project.name === 'mobile-chromium') await page.getByRole('button', { name:'Open sidebar' }).click()
  await expect(page.getByRole('button', { name:/E2E தமிழர்/ })).toBeVisible()
  await page.getByRole('button', { name:/E2E தமிழர்/ }).click()
  await page.getByRole('menuitem', { name:'Settings' }).click()
  await page.getByRole('button', { name:'Usage & billing' }).click()
  await expect(page.getByText('25k–180k tokens')).toBeVisible()
  await expect(page.getByText(/gpt-5-nano; model-dependent estimate, not a guaranteed quota/)).toBeVisible()
  await expect(page.getByText('Cached input tokens')).toBeVisible()
  await page.getByLabel('No monthly cap beyond prepaid AI credits').uncheck()
  await page.getByLabel(/Monthly cap \(AI credits\)/).fill('0.0012')
  await page.getByLabel('Warning threshold (%)').fill('80')
  await page.getByRole('button', { name:'Save usage limit' }).click()
  await expect.poll(() => state.hardLimit).toBe(1200)
  await page.getByRole('button', { name:'Close settings' }).click()
  if (testInfo.project.name === 'mobile-chromium') await page.getByRole('button', { name:'Close sidebar' }).first().click()
  await page.getByLabel('Message Swico').fill('within cap')
  await page.getByRole('button', { name:'Send message' }).click()
  await expect(page.getByText('வணக்கம் —')).toBeVisible()
  await page.getByLabel('Message Swico').fill('over cap')
  await page.getByRole('button', { name:'Send message' }).click()
  await expect(page.getByRole('alert')).toContainText(/monthly AI usage limit has been reached.*resets/i)
  expect(state.monthlyUsed).toBe(1200)

  if (testInfo.project.name === 'mobile-chromium') await page.getByRole('button', { name:'Open sidebar' }).click()
  await page.getByRole('button', { name:/E2E தமிழர்/ }).click()
  await page.getByRole('menuitem', { name:'Settings' }).click()
  await page.getByRole('button', { name:'Usage & billing' }).click()
  await expect(page.getByText(/reached your configured warning threshold/)).toBeVisible()
  await expect(page.getByText(/Resets .*Asia\/Kolkata/)).toBeVisible()
  await page.getByRole('button', { name:'Data controls' }).click()
  const dataControls = settings.getByRole('region', { name:'Data controls' })
  await expect(dataControls.getByRole('link', { name:'Terms' })).toHaveAttribute('href', '/legal/terms')
  await expect(dataControls.getByRole('link', { name:'Privacy' })).toHaveAttribute('href', '/legal/privacy')
  await expect(dataControls.getByRole('link', { name:'Refund and cancellation' })).toHaveAttribute('href', '/legal/refunds')
  await expect(dataControls.getByRole('link', { name:'Contact and support' })).toHaveAttribute('href', '/legal/contact')
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await expect(page.getByRole('button', { name:/E2E தமிழர்/ })).toBeFocused()
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
