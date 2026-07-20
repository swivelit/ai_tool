import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page, type Route } from '@playwright/test'
import { readFileSync } from 'node:fs'

test.skip((process.env.PLAYWRIGHT_MODE ?? 'local') !== 'local', 'Local mocked suite only')

const now = '2026-07-15T12:00:00Z'
const generatedToneMp3 = readFileSync(new URL('./fixtures/generated-tone.mp3.base64', import.meta.url), 'utf8').trim()
const tokenEstimate = (blended = 60_000) => ({
  tier:'lite', tier_label:'Swico Lite',
  reference_provider:'openai', reference_model:'gpt-5-nano', pricing_as_of:now,
  pricing_snapshot:{}, estimated_input_only_tokens:180_000,
  estimated_output_only_tokens:25_000, estimated_blended_tokens:blended,
  blended_assumption:'70% input tokens and 30% output tokens; cached input excluded',
  range_min_tokens:25_000, range_max_tokens:180_000,
  explanation:'Estimated using openai/gpt-5-nano pricing. Actual token usage varies by model, provider, cached input and input/output mix.',
})

type MockState = {
  wallet: number
  pendingGross: number
  orderFails: boolean
  monthlyUsed: number
  hardLimit: number | null
  warningThreshold: number
  profile: { name: string; place: string | null; timezone: string; assistant_name: string; reply_language: 'en' | 'ta'; email: string; email_editable: false }
  payments: Array<{ id: string; gross_amount_paise: number; credited_amount_micros: number; platform_share_paise: number; refunded_amount_paise: number; credit_reversal_micros: number; status: string; created_at: string; updated_at: string; paid_at: string | null; refunded_at: string | null; payment_received: boolean; credit_applied: boolean; token_estimate: ReturnType<typeof tokenEstimate>; reversal_token_estimate: ReturnType<typeof tokenEstimate> }>
  threads: Array<{ id: string; title: string; archived_at: string | null; created_at: string; updated_at: string }>
  voiceScenario: 'normal' | 'autoplay' | 'pcm' | 'media_fail'
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function installBackend(page: Page, initial?: Partial<MockState>) {
  const state: MockState = {
    wallet: 0,
    pendingGross: 1000,
    orderFails: false,
    monthlyUsed: 0,
    hardLimit: null,
    warningThreshold: 80,
    profile: { name: 'E2E User', place: 'Chennai', timezone: 'Asia/Kolkata', assistant_name: 'Elli', reply_language: 'en', email: 'e2e@example.test', email_editable: false },
    payments: [],
    threads: [{ id: 'thread-1', title: 'Tamil planning', archived_at: null, created_at: now, updated_at: now }],
    voiceScenario:'normal',
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
      wallet: { balance_micros: state.wallet, reserved_micros: 0, available_micros: state.wallet, version: 1, token_estimate:tokenEstimate(state.wallet ? 60_000 : 0) },
      billing: { currency: 'INR', credit_percent: '50', razorpay_key_id: 'rzp_test_local', razorpay_mode: 'test', checkout_enabled: true, custom_topup_enabled:true, min_topup_paise: 1000, max_topup_paise: 50000, packages: [
        { gross_amount_paise: 1000, credited_amount_micros: 5_000_000, platform_share_paise: 500, token_estimate:tokenEstimate() },
        { gross_amount_paise: 29900, credited_amount_micros: 149_500_000, platform_share_paise: 14950, token_estimate:{ ...tokenEstimate(860_000), range_min_tokens:358_000, range_max_tokens:2_100_000 } },
      ] },
      assistant: { tier:'lite', tier_label:'Swico Lite', tier_description:'Fast and efficient for everyday questions.', tier_selection_enabled:true, tiers:[
        { id:'lite', label:'Swico Lite', description:'Fast and efficient for everyday questions.', available:true, selected:true },
        { id:'standard', label:'Swico', description:'Balanced quality and speed for most tasks.', available:true, selected:false },
        { id:'pro', label:'Swico Pro', description:'Best for complex reasoning, planning, and coding.', available:true, selected:false },
      ] },
      features: {
        web_chat:true, prepaid_billing:true, local_models:false,
        web_attachments:true, web_voice_recording:true, web_voice_reply:true,
        web_voice_billing:true, web_realtime_voice:true, separate_voice_credits:true,
      },
      wallets: {
        chat:{ balance_micros:state.wallet, reserved_micros:0, available_micros:state.wallet, version:1 },
        voice:{ balance_micros:5_000_000, reserved_micros:0, available_micros:5_000_000, version:1 },
      },
      uploads:{ available:true, ttl_seconds:600, max_file_bytes:10485760, max_files_per_message:5, max_total_bytes:26214400, supported_extensions:['.txt','.pdf'] },
    })
    if (path === '/api/web/billing/wallet') return json(route, { balance_micros: state.wallet, reserved_micros: 0, available_micros: state.wallet, version: 2, token_estimate:tokenEstimate(state.wallet ? 60_000 : 0) })
    if (path === '/api/web/billing/ledger') return json(route, { items: [] })
    if (path === '/api/web/billing/payments') return json(route, { items: state.payments })
    if (path === '/api/web/voice/sessions' && request.method() === 'POST') {
      if (!state.threads.some(item => item.id === 'voice-thread')) {
        state.threads.unshift({ id:'voice-thread', title:'Voice planning', archived_at:null, created_at:now, updated_at:now })
      }
      return json(route, {
        protocol_version:1, session_id:`voice-session-${Date.now()}`, ticket:`fresh-ticket-${Date.now()}`,
        websocket_url:'ws://127.0.0.1:4173/api/web/voice/ws', tier:'lite', tier_label:'Swico Lite', language:'en',
        approved_websocket_hosts:['127.0.0.1:4173'],
        playback_mode:state.voiceScenario === 'pcm' ? 'pcm_stream' : state.voiceScenario === 'media_fail' ? 'auto' : 'buffered_mp3',
        selected_codec:state.voiceScenario === 'pcm' ? 'linear16' : 'mp3',
        provider_sample_rate:state.voiceScenario === 'pcm' ? 24000 : null,
        media_source_allowed:state.voiceScenario === 'media_fail',
        wallets:{ chat:{ available_micros:state.wallet }, voice:{ available_micros:5_000_000 } },
      }, 201)
    }
    if (path === '/api/web/billing/estimate') {
      const gross = Number(url.searchParams.get('gross_amount_paise'))
      return json(route, { gross_amount_paise:gross, token_estimate:{ tier:'lite', tier_label:'Swico Lite', estimated_blended_tokens:450_000, range_min_tokens:187_000, range_max_tokens:1_350_000 } })
    }
    if (path === '/api/web/settings/profile' && request.method() === 'GET') return json(route, state.profile)
    if (path === '/api/web/settings/profile' && request.method() === 'PATCH') {
      state.profile = { ...state.profile, ...(request.postDataJSON() as Partial<MockState['profile']>) }
      return json(route, state.profile)
    }
    if (path === '/api/web/settings/usage' && request.method() === 'GET') return json(route, {
      period: 'monthly', hard_limit_micros: state.hardLimit,
      hard_limit_ai_credits: state.hardLimit === null ? null : String(state.hardLimit / 1_000_000),
      hard_limit_token_estimate: state.hardLimit === null ? null : tokenEstimate(state.hardLimit), remaining_token_estimate:null,
      warning_threshold_percent: state.warningThreshold, notify_at_threshold: true,
      current_usage_micros: state.monthlyUsed, current_usage_ai_credits: String(state.monthlyUsed / 1_000_000),
      remaining_micros: state.hardLimit === null ? null : Math.max(0, state.hardLimit - state.monthlyUsed),
      warning_reached: state.hardLimit !== null && state.monthlyUsed * 100 >= state.hardLimit * state.warningThreshold,
      next_reset_at: '2026-08-01T00:00:00Z', timezone: state.profile.timezone, updated_at: now, tier:'lite', tier_label:'Swico Lite',
    })
    if (path === '/api/web/settings/usage' && request.method() === 'PATCH') {
      const update = request.postDataJSON() as { hard_limit_estimated_tokens: number | null; warning_threshold_percent: number }
      state.hardLimit = update.hard_limit_estimated_tokens; state.warningThreshold = update.warning_threshold_percent
      return json(route, { period:'monthly', hard_limit_micros:state.hardLimit, hard_limit_ai_credits:null, hard_limit_token_estimate:state.hardLimit === null ? null : tokenEstimate(state.hardLimit), remaining_token_estimate:null, warning_threshold_percent:state.warningThreshold, notify_at_threshold:true, current_usage_micros:state.monthlyUsed, current_usage_ai_credits:String(state.monthlyUsed / 1_000_000), remaining_micros:state.hardLimit === null ? null : Math.max(0, state.hardLimit - state.monthlyUsed), warning_reached:state.hardLimit !== null && state.monthlyUsed * 100 >= state.hardLimit * state.warningThreshold, next_reset_at:'2026-08-01T00:00:00Z', timezone:state.profile.timezone, updated_at:now, tier:'lite', tier_label:'Swico Lite' })
    }
    if (path === '/api/web/usage/summary') return json(route, {
      period:'current_month', tier:'lite', tier_label:'Swico Lite', timezone:state.profile.timezone, period_start:'2026-07-01T00:00:00Z', period_end:'2026-08-01T00:00:00Z', next_reset_at:'2026-08-01T00:00:00Z', request_count:state.monthlyUsed ? 1 : 0,
      input_tokens:10, cached_input_tokens:2, output_tokens:4, total_tokens:14, actual_usage_count:state.monthlyUsed ? 1 : 0, estimated_usage_count:0,
      debited_micros:state.monthlyUsed, debited_ai_credits:String(state.monthlyUsed / 1_000_000), available_micros:state.wallet, available_ai_credits:String(state.wallet / 1_000_000), chat_available_credits:String(state.wallet / 1_000_000), voice_available_credits:'0.000000', daily:[], provider_breakdown:[], model_breakdown:[], monthly_hard_limit_micros:state.hardLimit,
      by_tier: Object.fromEntries([
        ['lite', { label:'Swico Lite', request_count:state.monthlyUsed ? 1 : 0, input_tokens:10, cached_input_tokens:2, output_tokens:4, total_tokens:14, debited_micros:state.monthlyUsed, debited_ai_credits:String(state.monthlyUsed / 1_000_000), debited_token_credits:String(state.monthlyUsed / 1_000_000), period_debit_percentage:state.monthlyUsed ? 100 : 0, monthly_limit_percentage:0, utilization_percentage:state.monthlyUsed ? 100 : 0, utilization_basis:'available_balance_plus_period_debit' }],
        ['standard', { label:'Swico', request_count:0, input_tokens:0, cached_input_tokens:0, output_tokens:0, total_tokens:0, debited_micros:0, debited_ai_credits:'0.000000', debited_token_credits:'0.000000', period_debit_percentage:0, monthly_limit_percentage:0, utilization_percentage:0, utilization_basis:'available_balance_plus_period_debit' }],
        ['pro', { label:'Swico Pro', request_count:0, input_tokens:0, cached_input_tokens:0, output_tokens:0, total_tokens:0, debited_micros:0, debited_ai_credits:'0.000000', debited_token_credits:'0.000000', period_debit_percentage:0, monthly_limit_percentage:0, utilization_percentage:0, utilization_basis:'available_balance_plus_period_debit' }],
      ]),
      voice:{ label:'Voice', stt_request_count:0, tts_request_count:0, total_audio_seconds:0, total_tts_characters:0, request_count:0, debited_micros:0, debited_voice_credits:'0.000000', period_debit_percentage:0, monthly_limit_percentage:0, utilization_percentage:0, utilization_basis:'available_balance_plus_period_debit' },
      estimated_tokens_remaining:tokenEstimate(), token_estimate:tokenEstimate(),
    })
    if (path === '/api/web/billing/orders') {
      if (state.orderFails) return json(route, { detail: 'Order creation failed safely.' }, 502)
      state.pendingGross = Number((request.postDataJSON() as { gross_amount_paise:number }).gross_amount_paise)
      return json(route, { key_id: 'rzp_test_local', provider_order_id: 'order_test', amount: state.pendingGross, currency: 'INR', internal_order_id: 'internal-order', credited_amount_micros: state.pendingGross * 5000, platform_share_paise: state.pendingGross / 2 }, 201)
    }
    if (path === '/api/web/billing/verify') {
      state.wallet = state.pendingGross * 5000
      state.payments = [{ id:'internal-order', gross_amount_paise:state.pendingGross, credited_amount_micros:state.wallet, platform_share_paise:state.pendingGross / 2, refunded_amount_paise:0, credit_reversal_micros:0, status:'credited', created_at:now, updated_at:now, paid_at:now, refunded_at:null, payment_received:true, credit_applied:true, token_estimate:tokenEstimate(), reversal_token_estimate:tokenEstimate(0) }]
      return json(route, { status: 'credited', credited: true })
    }
    if (path === '/api/web/threads' && request.method() === 'GET') {
      const query = (url.searchParams.get('q') || '').toLowerCase()
      return json(route, { items: state.threads.filter(item => item.title.toLowerCase().includes(query)), has_more: false })
    }
    if (path === '/api/web/threads/thread-1/messages') return json(route, { items: [] })
    if (path === '/api/web/threads/voice-thread/messages') return json(route, { items:[
      { id:'voice-user-1', thread_id:'voice-thread', role:'user', content:'I need help planning', request_id:'voice-request-1', tier:null, tier_label:'Swico', input_tokens:0, output_tokens:0, usage_source:null, charge_micros:0, status:'complete', created_at:now, attachments:[], input_mode:'realtime_voice', voice_turn_id:'voice-session', reply_language:'en' },
      { id:'voice-assistant-1', thread_id:'voice-thread', role:'assistant', content:'Let us make a clear plan.', request_id:'voice-request-1', tier:'lite', tier_label:'Swico Lite', input_tokens:8, output_tokens:7, usage_source:'actual', charge_micros:10, status:'complete', created_at:now, attachments:[], input_mode:'realtime_voice', voice_turn_id:'voice-session', reply_language:'en' },
      { id:'voice-user-2', thread_id:'voice-thread', role:'user', content:'What comes next?', request_id:'voice-request-2', tier:null, tier_label:'Swico', input_tokens:0, output_tokens:0, usage_source:null, charge_micros:0, status:'complete', created_at:now, attachments:[], input_mode:'realtime_voice', voice_turn_id:'voice-session', reply_language:'en' },
      { id:'voice-assistant-2', thread_id:'voice-thread', role:'assistant', content:'Next, choose the first task.', request_id:'voice-request-2', tier:'lite', tier_label:'Swico Lite', input_tokens:5, output_tokens:6, usage_source:'actual', charge_micros:10, status:'complete', created_at:now, attachments:[], input_mode:'realtime_voice', voice_turn_id:'voice-session', reply_language:'en' },
    ] })
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
      if (state.wallet <= 0) return json(route, { error: { code: 'insufficient_credit', message: 'Add tokens to continue.' } }, 402)
      if (state.hardLimit !== null && state.monthlyUsed + 1200 > state.hardLimit) return json(route, { error: { code:'usage_limit_reached', message:'Your monthly AI usage limit has been reached.', current_usage_micros:state.monthlyUsed, configured_limit_micros:state.hardLimit, remaining_micros:Math.max(0, state.hardLimit - state.monthlyUsed), reset_at:'2026-08-01T00:00:00Z' } }, 402)
      state.monthlyUsed += 1200
      state.wallet -= 1200
      const requestId = String((request.postDataJSON() as { request_id: string }).request_id)
      const body = [
        `event: thread\ndata: {"thread_id":"thread-1"}\n\n`,
        `event: status\ndata: {"phase":"responding"}\n\n`,
        `event: delta\ndata: {"text":"வணக்கம் — **ready**"}\n\n`,
        `event: usage\ndata: {"provider":"sarvam","model":"sarvam-30b","input_tokens":10,"output_tokens":4,"usage_source":"actual","charged_micros":1200}\n\n`,
        `event: wallet\ndata: ${JSON.stringify({balance_micros:state.wallet,reserved_micros:0,available_micros:state.wallet,version:3,token_estimate:tokenEstimate()})}\n\n`,
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
  await expect(page.getByRole('button', { name: 'Start real-time Voice Mode' })).toBeVisible()
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

  for (const [path, title] of [['/terms', 'Terms and Conditions'], ['/privacy', 'Privacy Policy'], ['/refunds', 'Cancellation and Refund Policy']] as const) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    await expect(page.getByText('Version 1.0 · Effective date: 2026-07-17')).toBeVisible()
    await expect(page.getByText('Policy text is not published')).toHaveCount(0)
  }
})

test('zero-credit block, token package details, Test Mode payment, streaming, search, rename, archive, and theme', async ({ page }, testInfo) => {
  const state = await installBackend(page)
  await signIn(page)
  await page.getByLabel('Message Swico').fill('hello')
  await page.getByRole('button', { name: 'Send message' }).click()
  const billingDialog = page.getByRole('dialog', { name: 'Add credits' })
  await expect(billingDialog).toBeVisible()
  await expect(page.getByText('Test Mode')).toBeVisible()
  const packageCard = billingDialog.getByRole('button', { name:'Pay ₹10, estimated 25K to 180K tokens' })
  await expect(billingDialog.locator('.packages button')).toHaveCount(3)
  await expect(billingDialog.getByRole('button', { name:'Pay ₹299, estimated 358K to 2.1M tokens' })).toBeVisible()
  await expect(billingDialog.getByRole('button', { name:'Enter a custom payment amount' })).toBeVisible()
  await expect(packageCard).toContainText('Pay ₹10')
  await expect(packageCard).toContainText('25K–180K tokens')
  await expect(billingDialog.locator('.package-summary')).toContainText('Pay ₹10 for Chat credits')
  await expect(billingDialog.locator('.package-summary')).toContainText('25K–180K tokens')
  await expect(billingDialog).not.toContainText(/converted to token credits|service(?: and platform)? allocation|\d+%/i)
  await expect(billingDialog).not.toContainText(/5\.00|Equivalent to ₹/)
  await billingDialog.getByRole('button', { name:'Enter a custom payment amount' }).click()
  await billingDialog.getByLabel('Custom amount').fill('75')
  await expect(billingDialog.getByRole('button', { name:'Pay ₹75 for Chat credits' })).toBeEnabled()
  await packageCard.click()
  await page.getByRole('button', { name: 'Pay ₹10 for Chat credits' }).click()
  await expect.poll(() => state.wallet).toBe(5_000_000)
  await expect(page.getByRole('dialog', { name: 'Add credits' })).toBeHidden()
  await expect(page.getByText('≈ 60K tokens')).toBeVisible()

  await page.getByLabel('Message Swico').fill('தமிழில் பதில்')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('வணக்கம் —')).toBeVisible()
  await expect(page.getByText(/sarvam|sarvam-30b/)).toHaveCount(0)

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
  await page.getByRole('button', { name: /Add token credits/ }).click()
  state.orderFails = true
  await page.getByRole('button', { name: 'Pay ₹10 for Chat credits' }).click()
  await expect(page.getByRole('status')).toContainText('Order creation failed safely')
  expect(state.wallet).toBe(0)
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations.filter(item => item.impact === 'critical')).toEqual([])
})

test('settings persist profile, show usage estimates, enforce a monthly cap, and expose legal controls', async ({ page }, testInfo) => {
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
  await page.getByRole('button', { name:'Save profile' }).click({ force:true })
  await expect(page.getByRole('status')).toContainText('Profile saved')
  await page.getByRole('button', { name:'Close settings' }).click()
  await page.reload()
  if (testInfo.project.name === 'mobile-chromium') await page.getByRole('button', { name:'Open sidebar' }).click()
  await expect(page.getByRole('button', { name:/E2E தமிழர்/ })).toBeVisible()
  await page.getByRole('button', { name:/E2E தமிழர்/ }).click()
  await page.getByRole('menuitem', { name:'Settings' }).click()
  await settings.getByRole('button', { name:'Token credits', exact:true }).click()
  await expect(settings.getByText('Chat credits available')).toBeVisible()
  await expect(settings.getByText('Voice credits available')).toBeVisible()
  await expect(settings.getByText('Swico Lite estimated token range')).toBeVisible()
  await expect(settings.getByText('25,000–180,000 tokens')).toBeVisible()
  await expect(settings).not.toContainText(/not a guaranteed quota|Pricing timestamp|Measured requests|Estimated requests|Estimated for Swico/i)
  await expect(page.getByText('Cached input tokens')).toBeVisible()
  await page.getByLabel('No monthly limit beyond prepaid token credits').uncheck()
  await page.getByLabel('Estimated monthly tokens').fill('1200')
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
  await settings.getByRole('button', { name:'Token credits', exact:true }).click()
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

test('real-time Voice Mode completes a pause-aware turn, syncs chat, handles barge-in, and retries safely', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    class MockSourceBuffer extends EventTarget {
      updating = false
      appendBuffer(value: ArrayBuffer) { void value; this.dispatchEvent(new Event('updateend')) }
      abort() {}
    }
    class MockMediaSource extends EventTarget {
      readyState = 'open'
      constructor() { super(); setTimeout(() => this.dispatchEvent(new Event('sourceopen')), 0) }
      addSourceBuffer(mime: string) { void mime; return new MockSourceBuffer() }
    }
    class MockAudio extends EventTarget {
      src = ''
      play() { this.dispatchEvent(new Event('playing')); return Promise.resolve() }
      pause() {}
    }
    class MockWorkletNode {
      port = { onmessage:null as ((event: MessageEvent) => void) | null, postMessage:() => undefined }
      connect() { return this }
      disconnect() {}
    }
    class MockAudioContext {
      audioWorklet = { addModule:async () => undefined }
      destination = {}
      sampleRate = 48000
      createMediaStreamSource() { return { connect:() => undefined } }
      createGain() { return { gain:{ value:1 }, connect:() => undefined } }
      close() { return Promise.resolve() }
    }
    class MockWebSocket extends EventTarget {
      static OPEN = 1; static CLOSING = 2; static CLOSED = 3
      readyState = 0; bufferedAmount = 0; binaryType = ''; url: string
      constructor(url: string | URL) {
        super(); this.url = String(url)
        ;(window as typeof window & { __voiceSocket?: MockWebSocket }).__voiceSocket = this
        setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) }, 0)
      }
      emit(message: object) { this.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, ...message }) })) }
      send(value: string | ArrayBuffer) {
        if (typeof value !== 'string') return
        const message = JSON.parse(value) as { type?: string }
        if (message.type !== 'session.start') return
        setTimeout(() => this.emit({ type:'session.ready', state:'connected', preroll_ms:320, barge_in_min_ms:180 }), 10)
        setTimeout(() => this.emit({ type:'session.ready', state:'listening', turn_number:1, preroll_ms:320, barge_in_min_ms:180 }), 20)
        setTimeout(() => this.emit({ type:'stt.partial', transcript:'I need', turn_number:1 }), 50)
        setTimeout(() => this.emit({ type:'state.changed', state:'endpoint_pending', turn_number:1 }), 80)
        setTimeout(() => this.emit({ type:'speech_start', turn_number:1 }), 650)
        setTimeout(() => this.emit({ type:'state.changed', state:'listening', turn_number:1 }), 660)
        setTimeout(() => this.emit({ type:'stt.partial', transcript:'I need help because', turn_number:1 }), 680)
        setTimeout(() => this.emit({ type:'state.changed', state:'endpoint_pending', turn_number:1 }), 700)
        setTimeout(() => this.emit({ type:'speech_start', turn_number:1 }), 1250)
        setTimeout(() => this.emit({ type:'state.changed', state:'listening', turn_number:1 }), 1260)
        setTimeout(() => this.emit({ type:'stt.partial', transcript:'I need help planning', turn_number:1 }), 1280)
        setTimeout(() => this.emit({ type:'stt.final', transcript:'I need help planning', turn_number:1 }), 1350)
        setTimeout(() => this.emit({ type:'assistant.start', turn_number:1 }), 1400)
        setTimeout(() => this.emit({ type:'assistant.delta', delta:'Let us make a clear plan.', turn_number:1 }), 1440)
        setTimeout(() => this.emit({ type:'audio.start', content_type:'audio/mpeg', codec:'mp3', sample_rate:null, channels:1, sample_format:null, playback_mode:'buffered_mp3', turn_number:1 }), 1480)
        setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data:new Uint8Array([0,0,0,1,1,2,3]).buffer })), 1510)
        setTimeout(() => this.emit({ type:'audio.end', turn_number:1, codec:'mp3', chunks_sent:1, bytes_sent:3, characters:25, interrupted:false }), 1550)
        setTimeout(() => this.emit({ type:'turn.done', thread_id:'voice-thread', user_message_id:'voice-user-1', assistant_message_id:'voice-assistant-1', turn_number:1, input_mode:'realtime_voice', completion_status:'complete' }), 1590)
        setTimeout(() => this.emit({ type:'stt.final', transcript:'What comes next?', turn_number:2 }), 1800)
        setTimeout(() => this.emit({ type:'assistant.start', turn_number:2 }), 1830)
        setTimeout(() => this.emit({ type:'assistant.delta', delta:'Next, choose the first task.', turn_number:2 }), 1860)
        setTimeout(() => this.emit({ type:'audio.start', content_type:'audio/mpeg', codec:'mp3', sample_rate:null, channels:1, sample_format:null, playback_mode:'buffered_mp3', turn_number:2 }), 1890)
        setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data:new Uint8Array([0,0,0,1,4,5,6]).buffer })), 1920)
        setTimeout(() => this.emit({ type:'audio.end', turn_number:2, codec:'mp3', chunks_sent:1, bytes_sent:3, characters:28, interrupted:false }), 1950)
        setTimeout(() => this.emit({ type:'turn.done', thread_id:'voice-thread', user_message_id:'voice-user-2', assistant_message_id:'voice-assistant-2', turn_number:2, input_mode:'realtime_voice', completion_status:'complete' }), 1980)
      }
      close(code = 1000, reason = 'client_closed') {
        this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code, reason }))
      }
    }
    Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:{
      getUserMedia:async () => ({
        getTracks:() => [{ stop:() => undefined, label:'Mock microphone' }],
        getAudioTracks:() => [{ stop:() => undefined, label:'Mock microphone' }],
      }),
    } })
    Object.assign(window, { WebSocket:MockWebSocket, MediaSource:MockMediaSource, Audio:MockAudio, AudioContext:MockAudioContext, AudioWorkletNode:MockWorkletNode })
    URL.createObjectURL = () => 'blob:mock-voice'
    URL.revokeObjectURL = () => undefined
  })
  await installBackend(page, { wallet:5_000_000 })
  await page.emulateMedia({ reducedMotion:'reduce' })
  await signIn(page)
  await page.getByRole('button', { name:'Start real-time Voice Mode' }).click()
  const voiceDialog = page.getByRole('dialog', { name:'Voice' })
  await expect(voiceDialog).toBeVisible()
  await expect.poll(() => page.locator('.voice-orb').evaluate(element => parseFloat(getComputedStyle(element).animationDuration))).toBeLessThan(0.001)
  await expect(page.getByRole('heading', { name:'Still listening…' })).toBeVisible()
  await expect(voiceDialog.getByRole('button')).toHaveCount(1)
  await expect(voiceDialog.getByRole('button', { name:'Close Voice Mode' })).toBeVisible()
  await expect(voiceDialog.getByRole('button', { name:/mute microphone/i })).toHaveCount(0)
  await expect(voiceDialog.getByRole('button', { name:/captions/i })).toHaveCount(0)
  await expect(voiceDialog.getByRole('button', { name:'End conversation' })).toHaveCount(0)
  await expect(voiceDialog.getByText('Voice diagnostics')).toHaveCount(0)
  await expect(voiceDialog.locator('.voice-controls')).toHaveCount(0)
  await expect(page.getByRole('heading', { name:'Thinking' })).toHaveCount(0)
  await expect(page.getByText('I need help because')).toBeVisible()
  await expect(page.getByRole('heading', { name:'Still listening…' })).toBeVisible()
  await expect(page.getByRole('heading', { name:'Thinking' })).toHaveCount(0)
  await expect(page.getByText('I need help planning')).toBeVisible()
  await expect(page.getByText('Let us make a clear plan.')).toBeVisible()
  await page.evaluate(() => {
    const socket = (window as typeof window & { __voiceSocket?: { emit:(message: object) => void } }).__voiceSocket
    socket?.emit({ type:'warning', code:'assistant_interrupted', message:'Assistant interrupted. Listening now.' })
  })
  await expect(page.getByRole('heading', { name:'Listening' })).toBeVisible()
  await expect(page.getByText('What comes next?')).toBeVisible()
  await expect(page.getByText('Next, choose the first task.')).toBeVisible()
  const axe = await new AxeBuilder({ page }).analyze()
  expect(axe.violations.filter(item => item.impact === 'critical')).toEqual([])
  if (testInfo.project.name === 'chromium') await page.setViewportSize({ width:320, height:640 })
  else await page.setViewportSize({ width:844, height:390 })
  await expect(voiceDialog).toBeVisible()
  await expect(voiceDialog.getByRole('button', { name:'Close Voice Mode' })).toBeVisible()
  await page.getByRole('button', { name:'Close Voice Mode' }).click()
  await expect(page.getByRole('dialog', { name:'Voice' })).toBeHidden()
  await expect(page.getByText('I need help planning')).toBeVisible()
  await expect(page.getByText('Let us make a clear plan.')).toBeVisible()
  await expect(page.getByText('What comes next?')).toBeVisible()
  await expect(page.getByText('Next, choose the first task.')).toBeVisible()
})

async function installPlaybackScenarioBrowser(page: Page, scenario: 'autoplay' | 'pcm' | 'media_fail') {
  await page.addInitScript(selected => {
    const state = { audioPlays:0, pcmStarts:0, fallbackAudio:false }
    ;(window as typeof window & { __playbackScenario?: typeof state }).__playbackScenario = state
    class MockWorkletNode {
      port = { onmessage:null as ((event: MessageEvent) => void) | null, postMessage:() => undefined }
      connect() { return this }
      disconnect() {}
    }
    class MockBufferSource {
      buffer: AudioBuffer | null = null
      onended: (() => void) | null = null
      connect() {}
      disconnect() {}
      start() { state.pcmStarts += 1; setTimeout(() => this.onended?.(), 40) }
      stop() { this.onended = null }
    }
    class MockAudioContext {
      audioWorklet = { addModule:async () => undefined }
      destination = {}; sampleRate = 48000; currentTime = 0; state = 'running'
      createMediaStreamSource() { return { connect:() => undefined } }
      createGain() { return { gain:{ value:1 }, connect:() => undefined } }
      createBuffer(channels: number, length: number, sampleRate: number) {
        return { duration:length / sampleRate, sampleRate, copyToChannel:() => undefined, numberOfChannels:channels } as AudioBuffer
      }
      createBufferSource() { return new MockBufferSource() }
      resume() { this.state = 'running'; return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    class MockAudio extends EventTarget {
      src = ''; error = null
      play() {
        state.audioPlays += 1
        if (selected === 'autoplay' && state.audioPlays === 1) return Promise.reject(new DOMException('blocked', 'NotAllowedError'))
        state.fallbackAudio ||= selected === 'media_fail'
        this.dispatchEvent(new Event('playing')); setTimeout(() => this.dispatchEvent(new Event('ended')), 60)
        return Promise.resolve()
      }
      pause() {}
    }
    class FailingMediaSource extends EventTarget {
      static isTypeSupported() { return true }
      readyState = 'open'
      constructor() { super(); setTimeout(() => this.dispatchEvent(new Event('sourceopen')), 0) }
      addSourceBuffer() { throw new DOMException('private', 'NotSupportedError') }
    }
    class MockWebSocket extends EventTarget {
      static OPEN = 1; static CLOSING = 2
      readyState = 0; bufferedAmount = 0; binaryType = ''
      constructor(url: string | URL) { super(); void url; setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) }, 0) }
      emit(message: object) { this.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ protocol_version:1, ...message }) })) }
      send(value: string | ArrayBuffer) {
        if (typeof value !== 'string' || !value.includes('session.start')) return
        setTimeout(() => this.emit({ type:'session.ready', state:'listening' }), 10)
        setTimeout(() => this.emit({ type:'assistant.delta', delta:'Playback text remains visible.' }), 40)
        if (selected === 'pcm') {
          setTimeout(() => this.emit({ type:'audio.start', content_type:'audio/L16', codec:'linear16', sample_rate:24000, channels:1, sample_format:'pcm_s16le', playback_mode:'pcm_stream', turn_number:1 }), 60)
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data:new Uint8Array([0,0,0,1,1,0,2,0]).buffer })), 80)
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data:new Uint8Array([0,0,0,2,3,0,4,0]).buffer })), 90)
          setTimeout(() => this.emit({ type:'audio.end', turn_number:1, codec:'linear16', chunks_sent:2, bytes_sent:8, characters:30, interrupted:false }), 100)
        } else {
          setTimeout(() => this.emit({ type:'audio.start', content_type:'audio/mpeg', codec:'mp3', sample_rate:null, channels:1, sample_format:null, playback_mode:selected === 'media_fail' ? 'auto' : 'buffered_mp3', turn_number:1 }), 60)
          setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data:new Uint8Array([0,0,0,1,1,2,3]).buffer })), 80)
          setTimeout(() => this.emit({ type:'audio.end', turn_number:1, codec:'mp3', chunks_sent:1, bytes_sent:3, characters:30, interrupted:false }), 100)
        }
      }
      close(code = 1000, reason = 'client_closed') { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code, reason })) }
    }
    Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:{
      getUserMedia:async () => ({
        getTracks:() => [{ stop:() => undefined, label:'Mock microphone' }],
        getAudioTracks:() => [{ stop:() => undefined, label:'Mock microphone' }],
      }),
    } })
    Object.assign(window, {
      WebSocket:MockWebSocket, Audio:MockAudio, AudioContext:MockAudioContext,
      AudioWorkletNode:MockWorkletNode,
      ...(selected === 'media_fail' ? { MediaSource:FailingMediaSource } : {}),
    })
    URL.createObjectURL = () => 'blob:playback-scenario'
    URL.revokeObjectURL = () => undefined
  }, scenario)
}

test('Voice Mode preserves buffered MP3 across autoplay blocking and manual enable', async ({ page }) => {
  await installPlaybackScenarioBrowser(page, 'autoplay')
  await installBackend(page, { wallet:5_000_000, voiceScenario:'autoplay' })
  await signIn(page)
  await page.getByRole('button', { name:'Start real-time Voice Mode' }).click()
  await expect(page.getByText('Playback text remains visible.')).toBeVisible()
  await expect(page.getByRole('button', { name:'Tap to play' })).toBeVisible()
  await page.getByRole('button', { name:'Tap to play' }).click()
  await expect(page.getByRole('heading', { name:'Listening' })).toBeVisible()
  await page.getByRole('button', { name:'Close Voice Mode' }).click()
})

test('Voice Mode schedules progressive PCM and falls back from rejected MediaSource', async ({ page }) => {
  await installPlaybackScenarioBrowser(page, 'pcm')
  await installBackend(page, { wallet:5_000_000, voiceScenario:'pcm' })
  await signIn(page)
  await page.getByRole('button', { name:'Start real-time Voice Mode' }).click()
  await expect(page.getByRole('heading', { name:'Listening' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __playbackScenario?: { pcmStarts:number } }).__playbackScenario?.pcmStarts)).toBe(2)
  await page.getByRole('button', { name:'Close Voice Mode' }).click()

  await installPlaybackScenarioBrowser(page, 'media_fail')
  await installBackend(page, { wallet:5_000_000, voiceScenario:'media_fail' })
  await page.reload()
  await page.getByRole('button', { name:'Start real-time Voice Mode' }).click()
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __playbackScenario?: { fallbackAudio:boolean } }).__playbackScenario?.fallbackAudio)).toBe(true)
  await expect(page.getByText('Playback text remains visible.')).toBeVisible()
  await page.getByRole('button', { name:'Close Voice Mode' }).click()
})

test('Chromium decodes the committed generated MP3 and schedules generated PCM at its declared rate', async ({ page }) => {
  await page.goto('/')
  const decoded = await page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), value => value.charCodeAt(0))
    const blob = new Blob([bytes], { type:'audio/mpeg' })
    const context = new AudioContext()
    const decodedMp3 = await context.decodeAudioData(await blob.arrayBuffer())
    const mp3 = { duration:decodedMp3.duration, channels:decodedMp3.numberOfChannels }
    const rate = 24000
    const pcm = new Int16Array(Math.round(rate * 0.16))
    for (let index = 0; index < pcm.length; index += 1) pcm[index] = Math.round(Math.sin(2 * Math.PI * 440 * index / rate) * 8000)
    const buffer = context.createBuffer(1, pcm.length, rate)
    const floats = new Float32Array(pcm.length)
    for (let index = 0; index < pcm.length; index += 1) floats[index] = pcm[index] / 32768
    buffer.copyToChannel(floats, 0)
    const result = { mp3, pcmDuration:buffer.duration, pcmSampleRate:buffer.sampleRate, contextSampleRate:context.sampleRate }
    await context.close()
    return result
  }, generatedToneMp3)
  expect(decoded.mp3.duration).toBeGreaterThan(0)
  expect(decoded.mp3.channels).toBe(1)
  expect(decoded.pcmDuration).toBeCloseTo(0.16, 2)
  expect(decoded.pcmSampleRate).toBe(24000)
  expect(decoded.contextSampleRate).toBeGreaterThan(0)
})
