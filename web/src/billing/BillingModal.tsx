import { useEffect, useRef, useState } from 'react'
import { ShieldCheck, X } from 'lucide-react'
import type { User } from 'firebase/auth'
import { apiJson } from '../api/client'
import { formatRupeesFromPaise, tokenEstimateAvailable, tokenEstimateLabel } from '../credits'
import type { BillingConfig, BillingPackage, CreditBucket, PaymentHistory, ReferralSummary, SubscriptionPlan, SubscriptionSummary, TopupEstimateResponse, TopupTokenEstimate, VoiceCreditEstimate } from '../types'
import { loadRazorpay } from './razorpay'
import { pollPaymentStatus } from './paymentPolling'
import { paymentPresentation } from './paymentPresentation'

type Order = { key_id: string; provider_order_id: string; amount: number; currency: string; internal_order_id: string; credited_amount_micros: number; platform_share_paise: number; credit_bucket: CreditBucket; purchase_type?: 'topup' | 'subscription'; subscription_plan_code?: string | null }
type SelectionKey = 'preset-1500' | 'preset-29900' | 'custom'
type EstimateState = 'idle' | 'loading' | 'ready' | 'error'
const PRESETS = [1500, 29900] as const

function packageRupees(paise: number) {
  return paise % 100 === 0 ? `₹${paise / 100}` : formatRupeesFromPaise(paise)
}

function estimateRange(estimate: BillingPackage['token_estimate'] | TopupTokenEstimate | null) {
  return tokenEstimateLabel(estimate)
}

function packageAccessibleName(item: BillingPackage) {
  const amount = packageRupees(item.gross_amount_paise)
  const estimate = estimateRange(item.token_estimate)
  return estimate === 'Estimate temporarily unavailable' ? `Pay ${amount}, estimate temporarily unavailable` : `Pay ${amount}, estimated ${estimate.replace('–', ' to ')}`
}

function voiceEstimateLabel(estimate: VoiceCreditEstimate | null | undefined) {
  return estimate ? `About ${estimate.estimated_stt_minutes} STT-only min or ${estimate.estimated_tts_characters.toLocaleString()} TTS-only characters` : 'Estimate temporarily unavailable'
}

function subscriptionPlanLabel(code: string | null | undefined, plans: SubscriptionPlan[] = []) {
  return plans.find(plan => plan.code === code)?.label ?? ({ '1m': '1 month', '6m': '6 months', '1y': '1 year' }[code ?? ''] ?? 'Subscription')
}

function referralRewardLabel(code: string, value: { weeks: number; months: number }, plans: SubscriptionPlan[]) {
  const duration = value.months ? `${value.months} calendar month${value.months === 1 ? '' : 's'}` : `${value.weeks} week${value.weeks === 1 ? '' : 's'}`
  return `${subscriptionPlanLabel(code, plans)} subscription → ${duration} free`
}

function customAmount(value: string, config: BillingConfig): { paise: number | null; error: string | null } {
  if (!value) return { paise: null, error: null }
  if (!/^[0-9]+$/.test(value)) {
    return { paise: null, error: 'Enter a whole-rupee amount using numbers only.' }
  }
  const rupees = Number(value)
  const paise = rupees * 100
  if (!Number.isSafeInteger(rupees) || !Number.isSafeInteger(paise)) {
    return { paise: null, error: 'Enter a valid whole-rupee amount.' }
  }
  if (paise < config.min_topup_paise || paise > config.max_topup_paise) {
    return {
      paise: null,
      error: `Enter an amount from ${packageRupees(config.min_topup_paise)} to ${packageRupees(config.max_topup_paise)}.`,
    }
  }
  return { paise, error: null }
}

export function BillingModal({ user, config, initialBucket = 'chat', initialReferralCode = '', close, refreshed }: { user: User; config: BillingConfig; initialBucket?: CreditBucket; initialReferralCode?: string; close: () => void; refreshed: () => void }) {
  const [bucket, setBucket] = useState<CreditBucket>(initialBucket)
  const [selected, setSelected] = useState<SelectionKey>('preset-1500')
  const [customInput, setCustomInput] = useState('')
  const [customEstimate, setCustomEstimate] = useState<TopupEstimateResponse | null>(null)
  const [estimateState, setEstimateState] = useState<EstimateState>('idle')
  const [status, setStatus] = useState(''); const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'payg' | 'subscriptions' | 'referral' | 'history'>('payg')
  const [history, setHistory] = useState<PaymentHistory[]>([])
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [subscriptionState, setSubscriptionState] = useState<SubscriptionSummary | null>(null)
  const [referralState, setReferralState] = useState<ReferralSummary | null>(null)
  const [subscriptionPlan, setSubscriptionPlan] = useState<SubscriptionPlan | null>(null)
  const [referralInput, setReferralInput] = useState('')
  const dialogRef = useRef<HTMLElement>(null); const closeRef = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef<number | null>(null); const polling = useRef<AbortController | null>(null)
  const estimateRequest = useRef(0)
  const testMode = config.razorpay_mode === 'test'
  const custom = customAmount(customInput, config)
  const selectedPresetAmount = selected === 'preset-1500' ? 1500 : selected === 'preset-29900' ? 29900 : null
  const selectedPreset = selectedPresetAmount === null ? null : config.packages.find(item => item.gross_amount_paise === selectedPresetAmount) ?? null
  const selectedAmountPaise = selected === 'custom' ? custom.paise : selectedPresetAmount
  const selectedTokenEstimate = selected === 'custom' ? customEstimate?.token_estimate : selectedPreset?.token_estimate ?? null
  const selectedVoiceEstimate = selected === 'custom' ? customEstimate?.voice_estimate : selectedPreset?.voice_estimate ?? null
  const selectedEstimateReady = bucket === 'chat' ? tokenEstimateAvailable(selectedTokenEstimate) : Boolean(selectedVoiceEstimate && tokenEstimateAvailable(selectedTokenEstimate))
  const customReady = selected !== 'custom' || (custom.paise !== null && estimateState === 'ready' && customEstimate !== null)
  const checkoutReady = selectedAmountPaise !== null && selectedEstimateReady && customReady
  useEffect(() => {
    closeRef.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      if (event.key === 'Tab') {
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled)') ?? [])]
        if (!focusable.length) return
        const first = focusable[0]; const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', keyboard, true)
    return () => window.removeEventListener('keydown', keyboard, true)
  }, [busy, close])
  useEffect(() => {
    void apiJson<{ items: PaymentHistory[] }>(user, '/api/web/billing/payments')
      .then(data => { setHistory(data.items); setHistoryState('ready') })
      .catch(() => setHistoryState('error'))
  }, [user])
  useEffect(() => {
    if (tab !== 'subscriptions' || subscriptionState) return
    void apiJson<SubscriptionSummary>(user, '/api/web/billing/subscriptions').then(setSubscriptionState).catch(() => setSubscriptionState(null))
  }, [subscriptionState, tab, user])
  useEffect(() => {
    if (tab !== 'referral' || referralState) return
    void apiJson<ReferralSummary>(user, '/api/web/billing/referral').then(setReferralState).catch(() => setReferralState(null))
  }, [referralState, tab, user])
  useEffect(() => {
    if (initialReferralCode) setReferralInput(initialReferralCode)
  }, [initialReferralCode])
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    polling.current?.abort()
  }, [])
  useEffect(() => {
    const requestId = ++estimateRequest.current
    setCustomEstimate(null)
    if (selected !== 'custom' || !config.custom_topup_enabled || custom.paise === null || custom.error) {
      setEstimateState('idle')
      return
    }
    setEstimateState('loading')
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void apiJson<TopupEstimateResponse>(
        user,
        `/api/web/billing/estimate?gross_amount_paise=${custom.paise}&credit_bucket=${bucket}`,
        { signal: controller.signal },
      ).then(response => {
        if (requestId !== estimateRequest.current || response.gross_amount_paise !== custom.paise) return
        setCustomEstimate(response)
        setEstimateState('ready')
      }).catch(() => {
        if (requestId === estimateRequest.current && !controller.signal.aborted) setEstimateState('error')
      })
    }, 350)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [bucket, config.custom_topup_enabled, custom.error, custom.paise, selected, user])

  const closeSoon = () => { closeTimer.current = window.setTimeout(close, 500) }
  const finishPending = async (internalOrderId: string) => {
    setStatus('Payment received. Waiting for secure confirmation…')
    polling.current?.abort(); polling.current = new AbortController()
    const final = await pollPaymentStatus(user, internalOrderId, 2000, 30000, polling.current.signal)
    if (!final) { setStatus('Confirmation is still pending. Your balance will update automatically after the webhook arrives.'); return }
    if (final.status === 'credited' || final.status === 'fulfilled') { await Promise.resolve(refreshed()); setStatus(final.purchase_type === 'subscription' ? 'Subscription fulfilled.' : `${bucket === 'chat' ? 'Chat' : 'Voice'} credits added.`); closeSoon(); return }
    setStatus(final.status === 'failed' ? 'Payment failed. No credits were added.' : `Payment status: ${final.status.replaceAll('_', ' ')}.`)
  }

  const checkout = async () => {
    const subscriptionReady = tab === 'subscriptions' && subscriptionPlan !== null
    if ((!subscriptionReady && (!checkoutReady || selectedAmountPaise === null)) || busy || !config.checkout_enabled) return
    setBusy(true); setStatus('Creating secure order…')
    try {
      const order = await apiJson<Order>(user, '/api/web/billing/orders', {
        method: 'POST', body: JSON.stringify(tab === 'subscriptions'
          ? { purchase_type: 'subscription', plan_code: subscriptionPlan?.code, credit_bucket: bucket, idempotency_key: crypto.randomUUID() }
          : { purchase_type: 'topup', gross_amount_paise: selectedAmountPaise, credit_bucket: bucket, idempotency_key: crypto.randomUUID() }),
      })
      await loadRazorpay()
      if (!window.Razorpay) throw new Error('Checkout unavailable')
      setStatus('')
      const checkoutInstance = new window.Razorpay({
        key: order.key_id, amount: order.amount, currency: order.currency, order_id: order.provider_order_id,
        name: 'Swico', description: tab === 'subscriptions' ? `Prepaid ${bucket === 'chat' ? 'Chat' : 'Voice'} subscription` : `Prepaid ${bucket === 'chat' ? 'Chat' : 'Voice'} credits`, modal: { ondismiss: () => { setBusy(false); setStatus('Payment cancelled — no payment was confirmed.') } },
        handler: result => { void (async () => {
          setStatus('Confirming payment…')
          const verified = await apiJson<{ status: string; credited: boolean }>(user, '/api/web/billing/verify', {
            method: 'POST', body: JSON.stringify({ internal_order_id: order.internal_order_id, ...result }),
          })
          if (verified.credited || verified.status === 'fulfilled') { refreshed(); setStatus(tab === 'subscriptions' ? 'Subscription fulfilled.' : `${bucket === 'chat' ? 'Chat' : 'Voice'} credits added.`); closeSoon() }
          else await finishPending(order.internal_order_id)
          setBusy(false)
        })().catch(async () => { await finishPending(order.internal_order_id).catch(() => setStatus('Payment confirmation is pending.')); setBusy(false) }) },
      })
      checkoutInstance.on('payment.failed', () => { setStatus('Payment failed. No credits were added.'); setBusy(false) })
      checkoutInstance.open()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Order creation failed. Checkout was not opened.'); setBusy(false)
    }
  }
  const changeCustomInput = (value: string) => {
    setCustomInput(value)
    setCustomEstimate(null)
    setEstimateState('idle')
  }
  const payButtonLabel = busy ? 'Please wait…'
    : selected === 'custom' && custom.paise === null ? 'Enter a valid amount'
    : selected === 'custom' && estimateState === 'loading' ? 'Calculating estimate…'
    : selected === 'custom' && estimateState === 'error' ? 'Estimate temporarily unavailable'
    : tab === 'subscriptions' ? (subscriptionPlan ? `Subscribe for ${packageRupees(subscriptionPlan.price_paise)}` : 'Choose a subscription plan')
    : selectedAmountPaise !== null ? `Pay ${packageRupees(selectedAmountPaise)} for ${bucket === 'chat' ? 'Chat' : 'Voice'} credits`
    : 'Choose an amount'
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close() }}>
    <section ref={dialogRef} className="billing-modal" role="dialog" aria-modal="true" aria-labelledby="billing-title">
      <button ref={closeRef} className="modal-close icon-button" aria-label="Close billing" title="Close" disabled={busy} onClick={close}><X size={20} /></button>
      <div className="modal-heading"><span className="modal-icon"><ShieldCheck size={21} /></span><h2 id="billing-title">Billing</h2>{testMode && <strong className="test-mode">Test Mode</strong>}</div>
      <div className="billing-tabs" role="tablist" aria-label="Billing"><button role="tab" aria-selected={tab === 'payg'} className={tab === 'payg' ? 'active' : ''} onClick={() => { setTab('payg'); setStatus('') }}>Pay as you go</button><button role="tab" aria-selected={tab === 'subscriptions'} disabled={!config.subscriptions?.enabled} className={tab === 'subscriptions' ? 'active' : ''} onClick={() => { setTab('subscriptions'); setStatus('') }}>Subscriptions</button><button role="tab" aria-selected={tab === 'referral'} disabled={!config.referrals?.enabled} className={tab === 'referral' ? 'active' : ''} onClick={() => { setTab('referral'); setStatus('') }}>Referral rewards</button><button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => { setTab('history'); setStatus('') }}>Payment history</button></div>
      {tab === 'history' ? <div className="billing-history" aria-live="polite">
        {historyState === 'loading' && <p>Loading payment history…</p>}
        {historyState === 'error' && <p role="alert">Payment history could not be loaded.</p>}
        {historyState === 'ready' && !history.length && <p>No payments or refunds yet.</p>}
        {history.map(item => { const presentation = paymentPresentation(item); const itemBucket = item.credit_bucket ?? 'chat'; const subscription = item.purchase_type === 'subscription'; return <article key={item.id}><header><strong>{presentation.heading}</strong><span className="credit-bucket-label">{itemBucket === 'voice' ? 'Voice' : 'Chat'} {subscription ? 'subscription' : 'credits'}</span>{subscription && item.subscription_plan_code && <span>{subscriptionPlanLabel(item.subscription_plan_code, config.subscriptions?.plans)} · prepaid, no automatic renewal</span>}{presentation.detail && <span>{presentation.detail}</span>}</header><dl>
          {presentation.amountLabel && <div><dt>{presentation.amountLabel}</dt><dd>{formatRupeesFromPaise(item.gross_amount_paise)}</dd></div>}
          {presentation.showTokensAdded && itemBucket === 'chat' && <div><dt>{subscription ? 'Subscription status' : 'Estimated tokens added'}</dt><dd>{subscription ? 'Allowance available after fulfillment' : estimateRange(item.token_estimate)}</dd></div>}
          {presentation.showTokensAdded && itemBucket === 'voice' && <div><dt>Voice component estimates</dt><dd>{voiceEstimateLabel(item.voice_estimate)}. Realtime Voice also uses Voice credits for AI response generation.</dd></div>}
          {presentation.showRefundAmount && <div><dt>Refund amount</dt><dd>{formatRupeesFromPaise(item.refunded_amount_paise)}</dd></div>}
          {presentation.showReversalEstimate && <div><dt>Estimated tokens reversed</dt><dd>{estimateRange(item.reversal_token_estimate)}</dd></div>}
        </dl><span>{presentation.timestampLabel} <time dateTime={presentation.timestamp}>{new Date(presentation.timestamp).toLocaleDateString()}</time></span></article> })}
      </div> : tab === 'subscriptions' ? <>
        <div className="credit-bucket-tabs" role="group" aria-label="Subscription type"><button type="button" aria-pressed={bucket === 'chat'} className={bucket === 'chat' ? 'active' : ''} onClick={() => setBucket('chat')}>Chat</button><button type="button" aria-pressed={bucket === 'voice'} className={bucket === 'voice' ? 'active' : ''} onClick={() => setBucket('voice')}>Voice</button></div>
        <div className="subscription-cards">{(config.subscriptions?.plans ?? []).map(plan => <button key={plan.code} className={subscriptionPlan?.code === plan.code ? 'selected' : ''} aria-pressed={subscriptionPlan?.code === plan.code} onClick={() => setSubscriptionPlan(plan)}><strong>{plan.label}</strong><span>{packageRupees(plan.price_paise)}</span><small>~{estimateRange(config.subscriptions?.weekly_token_estimate)} per complete week · expires after {plan.duration_months} calendar month{plan.duration_months === 1 ? '' : 's'}</small></button>)}</div>
        <p className="subscription-note">Prepaid and non-renewing. Allowance starts at fulfillment, resets in seven-day windows from that start time, never rolls over, and the final partial week is prorated at expiry. Chat and Voice subscriptions are separate.</p>
        {subscriptionPlan && <div className="package-summary"><strong>{bucket === 'chat' ? 'Chat' : 'Voice'} · {subscriptionPlan.label} · {packageRupees(subscriptionPlan.price_paise)}</strong><span>Checkout amount is confirmed by the server.</span></div>}
        <button className="primary wide" disabled={busy || !subscriptionPlan || !config.checkout_enabled} onClick={() => void checkout()}>{payButtonLabel}</button>
        {status && <p className="payment-status" role="status" aria-live="polite">{status}</p>}
      </> : tab === 'referral' ? <div className="referral-panel">
        {!referralState && <p role="status">Loading referral rewards…</p>}
        {referralState && <><h3>Your referral code</h3><div className="referral-code"><code>{referralState.code ?? 'Unavailable'}</code>{referralState.code && <button type="button" onClick={() => void navigator.clipboard?.writeText(referralState.code ?? '')}>Copy code</button>}</div>{referralState.code && <button type="button" className="secondary-button" onClick={() => void navigator.clipboard?.writeText(`${window.location.origin}?ref=${encodeURIComponent(referralState.code ?? '')}`)}>Copy referral link</button>}<p>Rewards are earned by the referrer after a referred user's first successful subscription. Rewards are non-cash, non-transferable, and use the purchased Chat or Voice bucket.</p>{referralState.eligible_to_claim && <form onSubmit={event => { event.preventDefault(); void apiJson(user, '/api/web/billing/referral/claim', { method:'POST', body:JSON.stringify({ code: referralInput }) }).then(() => { setReferralInput(''); setStatus('Referral code claimed.'); return apiJson<ReferralSummary>(user, '/api/web/billing/referral').then(setReferralState) }).catch(error => setStatus(error instanceof Error ? error.message : 'Referral code could not be claimed.')) }}><label htmlFor="referral-code-input">Have a referral code?</label><input id="referral-code-input" value={referralInput} onChange={event => setReferralInput(event.target.value)} autoComplete="off" /><button className="primary" type="submit" disabled={!referralInput.trim()}>Claim code</button></form>}<h3>Reward mapping</h3><ul>{Object.entries(referralState.reward_mapping).map(([code, value]) => <li key={code}>{referralRewardLabel(code, value, config.subscriptions?.plans ?? [])}</li>)}</ul>{referralState.rewards.map(reward => <article key={reward.id}>{reward.status} · {subscriptionPlanLabel(reward.plan_code, config.subscriptions?.plans)} · {reward.credit_bucket}</article>)}</>}
      </div> : <>
      <div className="credit-bucket-tabs" role="group" aria-label="Credit type"><button type="button" aria-pressed={bucket === 'chat'} className={bucket === 'chat' ? 'active' : ''} onClick={() => { setBucket('chat'); setCustomEstimate(null) }}>Chat credits</button><button type="button" aria-pressed={bucket === 'voice'} className={bucket === 'voice' ? 'active' : ''} onClick={() => { setBucket('voice'); setCustomEstimate(null) }}>Voice credits</button></div>
      <div className="packages">{PRESETS.map(amount => {
        const item = config.packages.find(candidate => candidate.gross_amount_paise === amount)
        const key = `preset-${amount}` as SelectionKey
        const label = estimateRange(item?.token_estimate ?? null)
        return <button key={key} className={selected === key ? 'selected' : ''} aria-label={item && bucket === 'chat' ? packageAccessibleName(item) : `Pay ${packageRupees(amount)}, ${label}`} aria-pressed={selected === key} onClick={() => setSelected(key)}><strong>Pay {packageRupees(amount)}</strong><span>{label}</span></button>
      })}<button className={selected === 'custom' ? 'selected' : ''} aria-label="Enter a custom payment amount" aria-pressed={selected === 'custom'} aria-expanded={selected === 'custom'} aria-controls="custom-amount-fields" disabled={!config.custom_topup_enabled} onClick={() => setSelected('custom')}><strong>Custom amount</strong><span>{config.custom_topup_enabled ? 'Enter whole rupees' : 'Unavailable'}</span></button></div>
      {selected === 'custom' && <div id="custom-amount-fields" className="custom-amount-fields"><label htmlFor="custom-topup-rupees">Custom amount</label><div className="inr-input"><span aria-hidden="true">₹</span><input id="custom-topup-rupees" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" value={customInput} onChange={event => changeCustomInput(event.target.value)} aria-describedby={`custom-amount-help${custom.error ? ' custom-amount-error' : ''}`} aria-invalid={custom.paise === null} /></div><small id="custom-amount-help">Minimum {packageRupees(config.min_topup_paise)} · Maximum {packageRupees(config.max_topup_paise)}</small>{custom.error && <p id="custom-amount-error" className="custom-amount-error" role="alert">{custom.error}</p>}{custom.paise !== null && estimateState === 'loading' && <p className="custom-estimate-state" role="status">Calculating estimate…</p>}{estimateState === 'error' && <p className="custom-amount-error" role="alert">Token estimate is unavailable. Try again.</p>}</div>}
      {selectedAmountPaise !== null && selectedEstimateReady && <div className="package-summary"><strong>Pay {packageRupees(selectedAmountPaise)} for {bucket === 'chat' ? 'Chat' : 'Voice'} credits</strong>{bucket === 'chat' ? <span>Estimated token range <strong>{estimateRange(selectedTokenEstimate)}</strong></span> : <><span>Estimated token equivalent <strong>{tokenEstimateLabel(selectedTokenEstimate, 'token equivalent')}</strong></span><span>STT-only component estimate <strong>{selectedVoiceEstimate?.estimated_stt_minutes} minutes</strong></span><span>TTS-only component estimate <strong>{selectedVoiceEstimate?.estimated_tts_characters.toLocaleString()} characters</strong></span><small>Voice usage can include speech processing and AI response generation. Realtime Voice also uses Voice credits for AI response generation. These component-only estimates do not guarantee complete conversations. {selectedVoiceEstimate?.assumption}</small></>}</div>}
      {!config.checkout_enabled && <p className="checkout-disabled" role="status">Checkout is currently disabled. Existing Chat and Voice credits can still be used.</p>}
      <button className="primary wide" disabled={busy || !checkoutReady || !config.checkout_enabled} onClick={() => void checkout()}>{payButtonLabel}</button>
      {status && <p className="payment-status" role="status" aria-live="polite">{status}</p>}</>}
    </section>
  </div>
}
