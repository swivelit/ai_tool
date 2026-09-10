import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Code2, CreditCard, FileText, Gift, Headphones, History, Image as ImageIcon, Infinity, MessageCircle, Mic, Pencil, ShieldCheck, Sparkles, X, Zap } from 'lucide-react'
import type { User } from 'firebase/auth'
import { apiJson } from '../api/client'
import { formatRupeesForDisplay, formatRupeesFromPaise, tokenEstimateAvailable, tokenEstimateLabel } from '../credits'
import type { BillingConfig, BillingPackage, CreditBucket, PaymentHistory, ReferralSummary, SubscriptionPlan, SubscriptionSummary, TokenEstimate, TopupEstimateResponse, TopupTokenEstimate, VoiceCreditEstimate } from '../types'
import { loadRazorpay } from './razorpay'
import { pollPaymentStatus } from './paymentPolling'
import { paymentPresentation } from './paymentPresentation'

type Order = { key_id: string; provider_order_id: string; amount: number; currency: string; internal_order_id: string; credited_amount_micros: number; platform_share_paise: number; credit_bucket: CreditBucket; purchase_type?: 'topup' | 'subscription'; subscription_plan_code?: string | null }
type SelectionKey = 'preset-1500' | 'preset-29900' | 'custom'
type EstimateState = 'idle' | 'loading' | 'ready' | 'error'
const PRESETS = [1500, 29900] as const

function packageRupees(paise: number) {
  return formatRupeesForDisplay(paise)
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

function referralRewardStatus(status: string) {
  return ({ pending: 'Pending', earned: 'Earned', fulfilled: 'Earned', cancelled: 'Cancelled', manual_review: 'Manual review' }[status] ?? status.replaceAll('_', ' '))
}

function referralBucketLabel(bucket: string) {
  return bucket === 'voice' ? 'Voice' : bucket === 'chat' ? 'Chat' : bucket.replaceAll('_', ' ')
}

function weeklyAllowanceLabel(estimate: TokenEstimate | null | undefined, voice: boolean) {
  const value = tokenEstimateLabel(estimate, voice ? 'token equivalent' : 'tokens')
  if (value === 'Estimate temporarily unavailable') return value
  const labeled = voice ? value.replace(/ token equivalent$/, ' estimated token equivalent') : value
  return `${labeled} per complete week`
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
    : tab === 'subscriptions' ? (subscriptionPlan ? `Subscribe for ${packageRupees(subscriptionPlan.price_paise)}` : 'Choose a subscription plan')
    : selected === 'custom' && custom.paise === null ? 'Enter a valid amount'
    : selected === 'custom' && estimateState === 'loading' ? 'Calculating estimate…'
    : selected === 'custom' && estimateState === 'error' ? 'Estimate temporarily unavailable'
    : selectedAmountPaise !== null ? `Pay ${packageRupees(selectedAmountPaise)} for ${bucket === 'chat' ? 'Chat' : 'Voice'} credits`
    : 'Choose an amount'
  return <div className="modal-backdrop billing-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close() }}>
    <section ref={dialogRef} className="billing-modal billing-modal-redesign" role="dialog" aria-modal="true" aria-labelledby="billing-title">
      <style>{`
        .billing-modal-redesign {
          --billing-primary: #5b2ee8;
          --billing-primary-dark: #4220b8;
          --billing-primary-soft: #f1edff;
          --billing-border: #e7e5ee;
          --billing-muted: #6f6b7a;
          --billing-surface: #fff;
          width: min(100%, 1040px);
          max-height: min(92vh, 900px);
          overflow: auto;
          padding: 28px;
          border-radius: 24px;
          background: var(--billing-surface);
          box-shadow: 0 24px 80px rgba(31, 22, 54, .22);
          position: relative;
        }
        .billing-modal-redesign * { box-sizing: border-box; }
        .billing-redesign-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 20px;
          margin-bottom: 22px;
        }
        .billing-title-row {
          display: flex;
          align-items: center;
          gap: 14px;
        }
        .billing-title-icon {
          width: 48px;
          height: 48px;
          border-radius: 15px;
          display: grid;
          place-items: center;
          color: var(--billing-primary);
          background: var(--billing-primary-soft);
          flex: 0 0 auto;
        }
        .billing-title-copy h2 {
          margin: 0;
          font-size: 26px;
          line-height: 1.1;
          letter-spacing: -.02em;
        }
        .billing-title-copy p {
          margin: 5px 0 0;
          color: var(--billing-muted);
          font-size: 13px;
        }
        .billing-test-mode {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          margin-left: 8px;
          padding: 4px 8px;
          border-radius: 999px;
          background: #fff6dd;
          color: #8b6400;
          font-size: 11px;
          vertical-align: middle;
        }
        .billing-modal-redesign .modal-close {
          position: static;
          flex: 0 0 auto;
          width: 40px;
          height: 40px;
          border-radius: 12px;
          border: 1px solid var(--billing-border);
          background: #fff;
        }
        .billing-modal-redesign .modal-close:hover:not(:disabled) {
          background: #f8f7fb;
        }
        .billing-top-tabs {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 4px;
          padding: 4px;
          margin-bottom: 18px;
          border: 1px solid var(--billing-border);
          border-radius: 14px;
          background: #f7f6f9;
        }
        .billing-top-tabs button {
          min-height: 44px;
          padding: 9px 12px;
          border: 0;
          border-radius: 10px;
          background: transparent;
          color: #5f5b68;
          font-weight: 600;
          font-size: 13px;
          cursor: pointer;
        }
        .billing-top-tabs button.active {
          background: #fff;
          color: var(--billing-primary);
          box-shadow: 0 2px 8px rgba(25, 18, 50, .08);
        }
        .billing-top-tabs button:disabled {
          cursor: not-allowed;
          opacity: .45;
        }
        .billing-tab-label {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
        }
        .billing-credit-tabs {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 3px;
          padding: 3px;
          margin-bottom: 20px;
          border: 1px solid var(--billing-border);
          border-radius: 13px;
          background: #faf9fb;
        }
        .billing-credit-tabs button {
          min-height: 42px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          border: 0;
          border-radius: 10px;
          background: transparent;
          color: #6f6b78;
          font-weight: 650;
          cursor: pointer;
        }
        .billing-credit-tabs button.active {
          color: var(--billing-primary);
          background: #fff;
          box-shadow: 0 1px 5px rgba(25, 18, 50, .08);
        }
        .billing-plan-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 14px;
        }
        .billing-plan-card {
          position: relative;
          min-height: 174px;
          padding: 20px;
          text-align: left;
          border: 1px solid var(--billing-border);
          border-radius: 18px;
          background: #fff;
          color: #1f1c26;
          cursor: pointer;
          transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease;
        }
        .billing-plan-card:hover:not(:disabled) {
          transform: translateY(-2px);
          border-color: #cfc6f8;
          box-shadow: 0 10px 26px rgba(53, 35, 112, .08);
        }
        .billing-plan-card.selected {
          border: 2px solid var(--billing-primary);
          padding: 19px;
          background: linear-gradient(180deg, #fbf9ff 0%, #fff 100%);
          box-shadow: 0 12px 30px rgba(91, 46, 232, .11);
        }
        .billing-plan-badge {
          position: absolute;
          top: 12px;
          left: 12px;
          padding: 4px 8px;
          border-radius: 999px;
          background: var(--billing-primary);
          color: #fff;
          font-size: 9px;
          font-weight: 800;
          letter-spacing: .06em;
          text-transform: uppercase;
        }
        .billing-plan-check {
          position: absolute;
          top: 12px;
          right: 12px;
          width: 24px;
          height: 24px;
          display: grid;
          place-items: center;
          border-radius: 50%;
          background: var(--billing-primary);
          color: #fff;
        }
        .billing-plan-icon {
          width: 44px;
          height: 44px;
          display: grid;
          place-items: center;
          border-radius: 13px;
          margin-bottom: 15px;
          color: var(--billing-primary);
          background: #f2efff;
        }
        .billing-plan-card:nth-child(2) .billing-plan-icon {
          color: #16865f;
          background: #eafaf3;
        }
        .billing-plan-card:nth-child(3) .billing-plan-icon {
          color: #2b69d9;
          background: #edf4ff;
        }
        .billing-plan-card.selected .billing-plan-icon { margin-top: 12px; }
        .billing-plan-card strong {
          display: block;
          font-size: 20px;
          line-height: 1.2;
        }
        .billing-plan-estimate {
          display: block;
          margin-top: 6px;
          color: #706c78;
          font-size: 12px;
        }
        .billing-plan-description {
          display: inline-block;
          margin-top: 13px;
          padding: 5px 8px;
          border-radius: 999px;
          background: #f4f2fa;
          color: #635e72;
          font-size: 10px;
          font-weight: 650;
        }
        .billing-custom-fields {
          margin-top: 14px;
          padding: 16px;
          border: 1px solid var(--billing-border);
          border-radius: 15px;
          background: #faf9fc;
        }
        .billing-custom-fields label {
          display: block;
          margin-bottom: 7px;
          font-weight: 650;
          font-size: 13px;
        }
        .billing-custom-input {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 13px;
          border: 1px solid #dcd9e5;
          border-radius: 11px;
          background: #fff;
        }
        .billing-custom-input input {
          width: 100%;
          padding: 12px 0;
          border: 0;
          outline: 0;
          font-size: 16px;
          background: transparent;
        }
        .billing-custom-fields small { color: var(--billing-muted); }
        .billing-info-panel {
          margin-top: 18px;
          padding: 18px 20px;
          border: 1px solid #ebe7fb;
          border-radius: 17px;
          background: #faf9ff;
        }
        .billing-info-head {
          display: flex;
          align-items: center;
          gap: 9px;
          margin-bottom: 13px;
        }
        .billing-info-head h3 {
          margin: 0;
          font-size: 15px;
        }
        .billing-usage-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 9px;
        }
        .billing-usage-row strong { font-size: 15px; }
        .billing-usage-label { color: var(--billing-muted); font-size: 12px; }
        .billing-progress-track {
          height: 9px;
          overflow: hidden;
          border-radius: 999px;
          background: #e9e5f5;
        }
        .billing-progress-fill {
          width: 46%;
          height: 100%;
          border-radius: inherit;
          background: linear-gradient(90deg, #7a51ed, #5b2ee8);
          opacity: .28;
        }
        .billing-usage-note {
          margin: 8px 0 0;
          color: var(--billing-muted);
          font-size: 11px;
        }
        .billing-token-actions {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 10px;
          margin-top: 16px;
        }
        .billing-token-action {
          min-width: 0;
          padding: 12px;
          border-radius: 13px;
          background: #fff;
          border: 1px solid #eeeaf5;
        }
        .billing-token-action-icon {
          width: 31px;
          height: 31px;
          display: grid;
          place-items: center;
          border-radius: 9px;
          margin-bottom: 8px;
          color: var(--billing-primary);
          background: #f3efff;
        }
        .billing-token-action strong {
          display: block;
          font-size: 12px;
        }
        .billing-token-action span {
          display: block;
          margin-top: 3px;
          color: var(--billing-muted);
          font-size: 10px;
          line-height: 1.35;
        }
        .billing-payment-bar {
          position: sticky;
          bottom: -28px;
          z-index: 3;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 20px;
          margin: 22px -28px -28px;
          padding: 16px 20px;
          border-radius: 0 0 24px 24px;
          background: #24145f;
          color: #fff;
          box-shadow: 0 -8px 24px rgba(36, 20, 95, .12);
        }
        .billing-total {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
        }
        .billing-total-icon {
          width: 42px;
          height: 42px;
          display: grid;
          place-items: center;
          border-radius: 12px;
          background: rgba(255,255,255,.12);
          color: #fff;
        }
        .billing-total small {
          display: block;
          opacity: .72;
          font-size: 10px;
        }
        .billing-total strong {
          display: block;
          margin-top: 2px;
          font-size: 21px;
        }
        .billing-total strong span {
          margin-left: 5px;
          font-size: 11px;
          font-weight: 500;
          opacity: .72;
        }
        .billing-payment-button {
          min-width: 245px;
          min-height: 46px;
          padding: 0 18px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          border: 0;
          border-radius: 11px;
          background: #7041e8;
          color: #fff;
          font-weight: 750;
          cursor: pointer;
        }
        .billing-payment-button:hover:not(:disabled) { background: #8157ee; }
        .billing-payment-button:disabled { cursor: not-allowed; opacity: .55; }
        .billing-security-row {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 12px;
          padding-top: 18px;
        }
        .billing-security-item {
          display: flex;
          align-items: center;
          gap: 8px;
          color: var(--billing-muted);
          font-size: 10px;
        }
        .billing-security-item svg { color: #5b2ee8; flex: 0 0 auto; }
        .billing-redesign-status {
          margin: 12px 0 0;
          color: #514b60;
          font-size: 12px;
        }
        .billing-redesign-status[role="alert"] { color: #b42318; }
        .billing-secondary-content {
          margin-top: 18px;
        }
        .billing-secondary-content .subscription-cards {
          display: grid;
          gap: 10px;
        }
        @media (max-width: 760px) {
          .billing-modal-redesign {
            width: calc(100vw - 20px);
            max-height: 94vh;
            padding: 18px;
            border-radius: 19px;
          }
          .billing-redesign-header { margin-bottom: 15px; }
          .billing-title-icon { width: 42px; height: 42px; }
          .billing-title-copy h2 { font-size: 22px; }
          .billing-top-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .billing-plan-grid { grid-template-columns: 1fr; }
          .billing-plan-card { min-height: 145px; }
          .billing-token-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .billing-payment-bar {
            position: sticky;
            bottom: -18px;
            margin: 18px -18px -18px;
            padding: 14px;
            border-radius: 0 0 19px 19px;
            flex-direction: column;
            align-items: stretch;
          }
          .billing-payment-button { width: 100%; min-width: 0; }
          .billing-security-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 430px) {
          .billing-top-tabs button { font-size: 12px; }
          .billing-credit-tabs button { font-size: 12px; }
          .billing-plan-card { padding: 16px; }
          .billing-plan-card.selected { padding: 15px; }
        }
      `}</style>

      <div className="billing-redesign-header">
        <div className="billing-title-row">
          <span className="billing-title-icon" aria-hidden="true"><ShieldCheck size={24} /></span>
          <div className="billing-title-copy">
            <h2 id="billing-title">Billing {testMode && <span className="billing-test-mode">Test Mode</span>}</h2>
            <p>Manage your credits and payments</p>
          </div>
        </div>
        <button ref={closeRef} className="modal-close icon-button" aria-label="Close billing" title="Close" disabled={busy} onClick={close}>
          <X size={19} />
        </button>
      </div>

      <div className="billing-top-tabs" role="tablist" aria-label="Billing">
        <button role="tab" aria-selected={tab === 'payg'} className={tab === 'payg' ? 'active' : ''} onClick={() => { setTab('payg'); setStatus('') }}>
          <span className="billing-tab-label"><CreditCard size={15} /> Pay as you go</span>
        </button>
        <button role="tab" aria-selected={tab === 'subscriptions'} disabled={!config.subscriptions?.enabled} className={tab === 'subscriptions' ? 'active' : ''} onClick={() => { setTab('subscriptions'); setStatus('') }}>
          <span className="billing-tab-label"><Sparkles size={15} /> Subscriptions</span>
        </button>
        <button role="tab" aria-selected={tab === 'referral'} disabled={!config.referrals?.enabled} className={tab === 'referral' ? 'active' : ''} onClick={() => { setTab('referral'); setStatus('') }}>
          <span className="billing-tab-label"><Gift size={15} /> Referral rewards</span>
        </button>
        <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => { setTab('history'); setStatus('') }}>
          <span className="billing-tab-label"><History size={15} /> Payment history</span>
        </button>
      </div>

      {tab === 'history' ? <div className="billing-history" aria-live="polite">
        {historyState === 'loading' && <p>Loading payment history…</p>}
        {historyState === 'error' && <p role="alert">Payment history could not be loaded.</p>}
        {historyState === 'ready' && !history.length && <p>No payments or refunds yet.</p>}
        {history.map(item => { const presentation = paymentPresentation(item); const itemBucket = item.credit_bucket ?? 'chat'; const subscription = item.purchase_type === 'subscription'; return <article key={item.id}><header><strong>{presentation.heading}</strong><span className="credit-bucket-label">{itemBucket === 'voice' ? 'Voice' : 'Chat'} {subscription ? 'subscription' : 'credits'}</span>{subscription && item.subscription_plan_code && <span>{subscriptionPlanLabel(item.subscription_plan_code, config.subscriptions?.plans)} · prepaid, no automatic renewal</span>}{presentation.detail && <span>{presentation.detail}</span>}</header><dl>
          {presentation.amountLabel && <div><dt>{presentation.amountLabel}</dt><dd>{subscription ? formatRupeesForDisplay(item.gross_amount_paise) : formatRupeesFromPaise(item.gross_amount_paise)}</dd></div>}
          {presentation.showTokensAdded && itemBucket === 'chat' && <div><dt>{subscription ? 'Subscription status' : 'Estimated tokens added'}</dt><dd>{subscription ? 'Allowance available after fulfillment' : estimateRange(item.token_estimate)}</dd></div>}
          {presentation.showTokensAdded && itemBucket === 'voice' && <div><dt>Voice component estimates</dt><dd>{voiceEstimateLabel(item.voice_estimate)}. Realtime Voice also uses Voice credits for AI response generation.</dd></div>}
          {presentation.showRefundAmount && <div><dt>Refund amount</dt><dd>{subscription ? formatRupeesForDisplay(item.refunded_amount_paise) : formatRupeesFromPaise(item.refunded_amount_paise)}</dd></div>}
          {presentation.showReversalEstimate && <div><dt>Estimated tokens reversed</dt><dd>{estimateRange(item.reversal_token_estimate)}</dd></div>}
        </dl><span>{presentation.timestampLabel} <time dateTime={presentation.timestamp}>{new Date(presentation.timestamp).toLocaleDateString()}</time></span></article> })}
      </div> : tab === 'subscriptions' ? <>
        <div className="billing-credit-tabs" role="group" aria-label="Subscription type">
          <button type="button" aria-pressed={bucket === 'chat'} className={bucket === 'chat' ? 'active' : ''} onClick={() => setBucket('chat')}><MessageCircle size={16} /> Chat</button>
          <button type="button" aria-pressed={bucket === 'voice'} className={bucket === 'voice' ? 'active' : ''} onClick={() => setBucket('voice')}><Mic size={16} /> Voice</button>
        </div>
        <div className="subscription-cards billing-secondary-content">{(config.subscriptions?.plans ?? []).map(plan => <button key={plan.code} className={subscriptionPlan?.code === plan.code ? 'selected' : ''} aria-pressed={subscriptionPlan?.code === plan.code} onClick={() => setSubscriptionPlan(plan)}><strong>{plan.label}</strong><span>{packageRupees(plan.price_paise)}</span><small>{weeklyAllowanceLabel(config.subscriptions?.weekly_token_estimate, bucket === 'voice')} · expires after {plan.duration_months} calendar month{plan.duration_months === 1 ? '' : 's'}</small></button>)}</div>
        <p className="subscription-note">Prepaid and non-renewing. Allowance starts at fulfillment, resets in seven-day windows from that start time, never rolls over, and the final partial week is prorated at expiry. Chat and Voice subscriptions are separate.</p>
        {subscriptionPlan && <div className="package-summary"><strong>{bucket === 'chat' ? 'Chat' : 'Voice'} · {subscriptionPlan.label} · {packageRupees(subscriptionPlan.price_paise)}</strong><span>Checkout amount is confirmed by the server.</span></div>}
        <button className="primary wide" disabled={busy || !subscriptionPlan || !config.checkout_enabled} onClick={() => void checkout()}>{payButtonLabel}</button>
        {status && <p className="payment-status" role="status" aria-live="polite">{status}</p>}
      </> : tab === 'referral' ? <div className="referral-panel">
        {!referralState && <p role="status">Loading referral rewards…</p>}
        {referralState && <><h3>Your referral code</h3><div className="referral-code"><code>{referralState.code ?? 'Unavailable'}</code>{referralState.code && <button type="button" onClick={() => void navigator.clipboard?.writeText(referralState.code ?? '')}>Copy code</button>}</div>{referralState.code && <button type="button" className="secondary-button" onClick={() => void navigator.clipboard?.writeText(`${window.location.origin}?ref=${encodeURIComponent(referralState.code ?? '')}`)}>Copy referral link</button>}<p>Rewards are earned by the referrer after a referred user's first successful subscription. Rewards are non-cash, non-transferable, and use the purchased Chat or Voice bucket.</p>{referralState.eligible_to_claim && <form onSubmit={event => { event.preventDefault(); void apiJson(user, '/api/web/billing/referral/claim', { method:'POST', body:JSON.stringify({ code: referralInput }) }).then(() => { setReferralInput(''); setStatus('Referral code claimed.'); return apiJson<ReferralSummary>(user, '/api/web/billing/referral').then(setReferralState) }).catch(error => setStatus(error instanceof Error ? error.message : 'Referral code could not be claimed.')) }}><label htmlFor="referral-code-input">Have a referral code?</label><input id="referral-code-input" value={referralInput} onChange={event => setReferralInput(event.target.value)} autoComplete="off" /><button className="primary" type="submit" disabled={!referralInput.trim()}>Claim code</button></form>}<h3>Reward mapping</h3><ul>{Object.entries(referralState.reward_mapping).map(([code, value]) => <li key={code}>{referralRewardLabel(code, value, config.subscriptions?.plans ?? [])}</li>)}</ul>{referralState.rewards.map(reward => <article key={reward.id}>{referralRewardStatus(reward.status)} · {subscriptionPlanLabel(reward.plan_code, config.subscriptions?.plans)} · {referralBucketLabel(reward.credit_bucket)}</article>)}</>}
      </div> : <>
        <div className="billing-credit-tabs" role="group" aria-label="Credit type">
          <button type="button" aria-pressed={bucket === 'chat'} className={bucket === 'chat' ? 'active' : ''} onClick={() => { setBucket('chat'); setCustomEstimate(null) }}><MessageCircle size={16} /> Chat credits</button>
          <button type="button" aria-pressed={bucket === 'voice'} className={bucket === 'voice' ? 'active' : ''} onClick={() => { setBucket('voice'); setCustomEstimate(null) }}><Mic size={16} /> Voice credits</button>
        </div>

        <div className="billing-plan-grid">
          {PRESETS.map(amount => {
            const item = config.packages.find(candidate => candidate.gross_amount_paise === amount)
            const key = `preset-${amount}` as SelectionKey
            const label = estimateRange(item?.token_estimate ?? null)
            const isSelected = selected === key
            const isPopular = amount === 1500
            return <button key={key} type="button" className={`billing-plan-card ${isSelected ? 'selected' : ''}`} aria-label={item && bucket === 'chat' ? packageAccessibleName(item) : `Pay ${packageRupees(amount)}, ${label}`} aria-pressed={isSelected} onClick={() => setSelected(key)}>
              {isPopular && <span className="billing-plan-badge">Popular</span>}
              {isSelected && <span className="billing-plan-check" aria-hidden="true"><Check size={14} strokeWidth={3} /></span>}
              <span className="billing-plan-icon" aria-hidden="true">{amount === 1500 ? <MessageCircle size={22} /> : <Zap size={22} />}</span>
              <strong>Pay {packageRupees(amount)}</strong>
              <span className="billing-plan-estimate">{label}</span>
              <span className="billing-plan-description">{amount === 1500 ? 'Best for light usage' : 'Best value'}</span>
            </button>
          })}
          <button type="button" className={`billing-plan-card ${selected === 'custom' ? 'selected' : ''}`} aria-label="Enter a custom payment amount" aria-pressed={selected === 'custom'} aria-expanded={selected === 'custom'} aria-controls="custom-amount-fields" disabled={!config.custom_topup_enabled} onClick={() => setSelected('custom')}>
            {selected === 'custom' && <span className="billing-plan-check" aria-hidden="true"><Check size={14} strokeWidth={3} /></span>}
            <span className="billing-plan-icon" aria-hidden="true"><Pencil size={22} /></span>
            <strong>Custom amount</strong>
            <span className="billing-plan-estimate">{config.custom_topup_enabled ? 'Enter whole rupees' : 'Unavailable'}</span>
            <span className="billing-plan-description">Flexible &amp; custom</span>
          </button>
        </div>

        {selected === 'custom' && <div id="custom-amount-fields" className="billing-custom-fields">
          <label htmlFor="custom-topup-rupees">Custom amount</label>
          <div className="billing-custom-input">
            <span aria-hidden="true">₹</span>
            <input id="custom-topup-rupees" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" value={customInput} onChange={event => changeCustomInput(event.target.value)} aria-describedby={`custom-amount-help${custom.error ? ' custom-amount-error' : ''}`} aria-invalid={custom.paise === null} />
          </div>
          <small id="custom-amount-help">Minimum {packageRupees(config.min_topup_paise)} · Maximum {packageRupees(config.max_topup_paise)}</small>
          {custom.error && <p id="custom-amount-error" className="custom-amount-error" role="alert">{custom.error}</p>}
          {custom.paise !== null && estimateState === 'loading' && <p className="custom-estimate-state" role="status">Calculating estimate…</p>}
          {estimateState === 'error' && <p className="custom-amount-error" role="alert">Token estimate is unavailable. Try again.</p>}
        </div>}

        {selectedAmountPaise !== null && selectedEstimateReady && <div className="billing-info-panel">
          <div className="billing-info-head">
            <span className="billing-title-icon" style={{ width: 34, height: 34, borderRadius: 10 }} aria-hidden="true"><Sparkles size={17} /></span>
            <h3>{bucket === 'chat' ? 'Token usage estimate' : 'Voice credit estimate'}</h3>
          </div>
          <div className="billing-usage-row">
            <div>
              <span className="billing-usage-label">Estimated available range</span>
              <strong>{bucket === 'chat' ? estimateRange(selectedTokenEstimate) : tokenEstimateLabel(selectedTokenEstimate, 'token equivalent')}</strong>
            </div>
            <span className="billing-usage-label">Selected package</span>
          </div>
          <div className="billing-progress-track" aria-hidden="true">
            <div className="billing-progress-fill" />
          </div>
          <p className="billing-usage-note">The current BillingModal does not expose consumed-token totals, so this progress track is intentionally a visual capacity indicator rather than a claim about tokens already used.</p>

          <div className="billing-info-head" style={{ marginTop: 18 }}>
            <span className="billing-title-icon" style={{ width: 34, height: 34, borderRadius: 10 }} aria-hidden="true"><Sparkles size={17} /></span>
            <h3>What you can do with your tokens</h3>
          </div>
          <div className="billing-token-actions">
            <div className="billing-token-action"><span className="billing-token-action-icon"><MessageCircle size={16} /></span><strong>Text messages</strong><span>Chat usage based on your selected token range</span></div>
            <div className="billing-token-action"><span className="billing-token-action-icon"><FileText size={16} /></span><strong>Documents</strong><span>Token use varies with document size</span></div>
            <div className="billing-token-action"><span className="billing-token-action-icon"><ImageIcon size={16} /></span><strong>Images</strong><span>Token use varies by image and request</span></div>
            <div className="billing-token-action"><span className="billing-token-action-icon"><Code2 size={16} /></span><strong>Code &amp; more</strong><span>Useful for coding and longer prompts</span></div>
          </div>
        </div>}

        {selectedAmountPaise !== null && selectedEstimateReady && <div className="package-summary"><strong>Pay {packageRupees(selectedAmountPaise)} for {bucket === 'chat' ? 'Chat' : 'Voice'} credits</strong>{bucket === 'chat' ? <span>Estimated token range <strong>{estimateRange(selectedTokenEstimate)}</strong></span> : <><span>Estimated token equivalent <strong>{tokenEstimateLabel(selectedTokenEstimate, 'token equivalent')}</strong></span><span>STT-only component estimate <strong>{selectedVoiceEstimate?.estimated_stt_minutes} minutes</strong></span><span>TTS-only component estimate <strong>{selectedVoiceEstimate?.estimated_tts_characters.toLocaleString()} characters</strong></span><small>Voice usage can include speech processing and AI response generation. Realtime Voice also uses Voice credits for AI response generation. These component-only estimates do not guarantee complete conversations. {selectedVoiceEstimate?.assumption}</small></>}</div>}

        {!config.checkout_enabled && <p className="checkout-disabled" role="status">Checkout is currently disabled. Existing Chat and Voice credits can still be used.</p>}

        <div className="billing-payment-bar">
          <div className="billing-total">
            <span className="billing-total-icon" aria-hidden="true"><CreditCard size={19} /></span>
            <div>
              <small>Total to pay</small>
              <strong>{selectedAmountPaise !== null ? packageRupees(selectedAmountPaise) : '—'}<span>({bucket === 'chat' ? 'Chat credits' : 'Voice credits'})</span></strong>
            </div>
          </div>
          <button className="billing-payment-button" disabled={busy || !checkoutReady || !config.checkout_enabled} onClick={() => void checkout()}>
            {payButtonLabel}<ChevronRight size={17} />
          </button>
        </div>

        <div className="billing-security-row" aria-label="Payment assurances">
          <div className="billing-security-item"><ShieldCheck size={17} /><span><strong>Secure checkout</strong><br />Razorpay payment flow</span></div>
          <div className="billing-security-item"><Zap size={17} /><span><strong>Server confirmed</strong><br />Checkout amount is verified</span></div>
          <div className="billing-security-item"><Infinity size={17} /><span><strong>Prepaid credits</strong><br />Credits are added after fulfillment</span></div>
          <div className="billing-security-item"><Headphones size={17} /><span><strong>Chat &amp; Voice</strong><br />Separate credit buckets</span></div>
        </div>

        {status && <p className="payment-status billing-redesign-status" role="status" aria-live="polite">{status}</p>}
      </>}
    </section>
  </div>
}
