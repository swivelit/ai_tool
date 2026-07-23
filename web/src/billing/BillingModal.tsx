import { useEffect, useRef, useState } from 'react'
import { ShieldCheck, X } from 'lucide-react'
import type { User } from 'firebase/auth'
import { apiJson } from '../api/client'
import { formatRupeesFromPaise, tokenRangeLabel } from '../credits'
import type { BillingConfig, BillingPackage, CreditBucket, PaymentHistory, TopupEstimateResponse, TopupTokenEstimate, VoiceCreditEstimate } from '../types'
import { loadRazorpay } from './razorpay'
import { pollPaymentStatus } from './paymentPolling'
import { paymentPresentation } from './paymentPresentation'

type Order = { key_id: string; provider_order_id: string; amount: number; currency: string; internal_order_id: string; credited_amount_micros: number; platform_share_paise: number; credit_bucket: CreditBucket }
type SelectionKey = 'preset-1500' | 'preset-29900' | 'custom'
type EstimateState = 'idle' | 'loading' | 'ready' | 'error'
const PRESETS = [1500, 29900] as const

function packageRupees(paise: number) {
  return paise % 100 === 0 ? `₹${paise / 100}` : formatRupeesFromPaise(paise)
}

function estimateRange(estimate: BillingPackage['token_estimate'] | TopupTokenEstimate | null) {
  return estimate ? tokenRangeLabel(estimate.range_min_tokens, estimate.range_max_tokens) : 'Estimate unavailable'
}

function packageAccessibleName(item: BillingPackage) {
  const amount = packageRupees(item.gross_amount_paise)
  const estimate = estimateRange(item.token_estimate)
  return estimate === 'Estimate unavailable' ? `Pay ${amount}, estimate unavailable` : `Pay ${amount}, estimated ${estimate.replace('–', ' to ')}`
}

function voiceEstimateLabel(estimate: VoiceCreditEstimate | null | undefined) {
  return estimate ? `About ${estimate.estimated_stt_minutes} STT-only min or ${estimate.estimated_tts_characters.toLocaleString()} TTS-only characters` : 'Estimate unavailable'
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

export function BillingModal({ user, config, initialBucket = 'chat', close, refreshed }: { user: User; config: BillingConfig; initialBucket?: CreditBucket; close: () => void; refreshed: () => void }) {
  const [bucket, setBucket] = useState<CreditBucket>(initialBucket)
  const [selected, setSelected] = useState<SelectionKey>('preset-1500')
  const [customInput, setCustomInput] = useState('')
  const [customEstimate, setCustomEstimate] = useState<TopupEstimateResponse | null>(null)
  const [estimateState, setEstimateState] = useState<EstimateState>('idle')
  const [status, setStatus] = useState(''); const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'topup' | 'history'>('topup')
  const [history, setHistory] = useState<PaymentHistory[]>([])
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading')
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
  const selectedEstimateReady = bucket === 'chat' ? selectedTokenEstimate !== null : selectedVoiceEstimate !== null
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
    if (final.status === 'credited') { await Promise.resolve(refreshed()); setStatus(`${bucket === 'chat' ? 'Chat' : 'Voice'} credits added.`); closeSoon(); return }
    setStatus(final.status === 'failed' ? 'Payment failed. No credits were added.' : `Payment status: ${final.status.replaceAll('_', ' ')}.`)
  }

  const checkout = async () => {
    if (!checkoutReady || selectedAmountPaise === null || busy || !config.checkout_enabled) return
    setBusy(true); setStatus('Creating secure order…')
    try {
      const order = await apiJson<Order>(user, '/api/web/billing/orders', {
        method: 'POST', body: JSON.stringify({ gross_amount_paise: selectedAmountPaise, credit_bucket: bucket, idempotency_key: crypto.randomUUID() }),
      })
      await loadRazorpay()
      if (!window.Razorpay) throw new Error('Checkout unavailable')
      setStatus('')
      const checkoutInstance = new window.Razorpay({
        key: order.key_id, amount: order.amount, currency: order.currency, order_id: order.provider_order_id,
        name: 'Swico', description: `Prepaid ${bucket === 'chat' ? 'Chat' : 'Voice'} credits`, modal: { ondismiss: () => { setBusy(false); setStatus('Payment cancelled — no credits were added.') } },
        handler: result => { void (async () => {
          setStatus('Confirming payment…')
          const verified = await apiJson<{ status: string; credited: boolean }>(user, '/api/web/billing/verify', {
            method: 'POST', body: JSON.stringify({ internal_order_id: order.internal_order_id, ...result }),
          })
          if (verified.credited) { refreshed(); setStatus(`${bucket === 'chat' ? 'Chat' : 'Voice'} credits added.`); closeSoon() }
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
    : selected === 'custom' && estimateState === 'error' ? 'Estimate unavailable'
    : selectedAmountPaise !== null ? `Pay ${packageRupees(selectedAmountPaise)} for ${bucket === 'chat' ? 'Chat' : 'Voice'} credits`
    : 'Choose an amount'
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close() }}>
    <section ref={dialogRef} className="billing-modal" role="dialog" aria-modal="true" aria-labelledby="billing-title">
      <button ref={closeRef} className="modal-close icon-button" aria-label="Close add credits" title="Close" disabled={busy} onClick={close}><X size={20} /></button>
      <div className="modal-heading"><span className="modal-icon"><ShieldCheck size={21} /></span><h2 id="billing-title">Add credits</h2>{testMode && <strong className="test-mode">Test Mode</strong>}</div>
      <div className="billing-tabs" role="tablist" aria-label="Billing"><button role="tab" aria-selected={tab === 'topup'} className={tab === 'topup' ? 'active' : ''} onClick={() => setTab('topup')}>Add credits</button><button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>Payment history</button></div>
      {tab === 'history' ? <div className="billing-history" aria-live="polite">
        {historyState === 'loading' && <p>Loading payment history…</p>}
        {historyState === 'error' && <p role="alert">Payment history could not be loaded.</p>}
        {historyState === 'ready' && !history.length && <p>No payments or refunds yet.</p>}
        {history.map(item => { const presentation = paymentPresentation(item); const itemBucket = item.credit_bucket ?? 'chat'; return <article key={item.id}><header><strong>{presentation.heading}</strong><span className="credit-bucket-label">{itemBucket === 'voice' ? 'Voice' : 'Chat'} credits</span>{presentation.detail && <span>{presentation.detail}</span>}</header><dl>
          {presentation.amountLabel && <div><dt>{presentation.amountLabel}</dt><dd>{formatRupeesFromPaise(item.gross_amount_paise)}</dd></div>}
          {presentation.showTokensAdded && itemBucket === 'chat' && <div><dt>Estimated tokens added</dt><dd>{estimateRange(item.token_estimate)}</dd></div>}
          {presentation.showTokensAdded && itemBucket === 'voice' && <div><dt>Voice component estimates</dt><dd>{voiceEstimateLabel(item.voice_estimate)}. Realtime Voice also uses Voice credits for AI response generation.</dd></div>}
          {presentation.showRefundAmount && <div><dt>Refund amount</dt><dd>{formatRupeesFromPaise(item.refunded_amount_paise)}</dd></div>}
          {presentation.showReversalEstimate && <div><dt>Estimated tokens reversed</dt><dd>{estimateRange(item.reversal_token_estimate)}</dd></div>}
        </dl><span>{presentation.timestampLabel} <time dateTime={presentation.timestamp}>{new Date(presentation.timestamp).toLocaleDateString()}</time></span></article> })}
      </div> : <>
      <div className="credit-bucket-tabs" role="group" aria-label="Credit type"><button type="button" aria-pressed={bucket === 'chat'} className={bucket === 'chat' ? 'active' : ''} onClick={() => { setBucket('chat'); setCustomEstimate(null) }}>Chat credits</button><button type="button" aria-pressed={bucket === 'voice'} className={bucket === 'voice' ? 'active' : ''} onClick={() => { setBucket('voice'); setCustomEstimate(null) }}>Voice credits</button></div>
      <div className="packages">{PRESETS.map(amount => {
        const item = config.packages.find(candidate => candidate.gross_amount_paise === amount)
        const key = `preset-${amount}` as SelectionKey
        const label = bucket === 'chat' ? estimateRange(item?.token_estimate ?? null) : voiceEstimateLabel(item?.voice_estimate)
        return <button key={key} className={selected === key ? 'selected' : ''} aria-label={item && bucket === 'chat' ? packageAccessibleName(item) : `Pay ${packageRupees(amount)}, ${label}`} aria-pressed={selected === key} onClick={() => setSelected(key)}><strong>Pay {packageRupees(amount)}</strong><span>{label}</span></button>
      })}<button className={selected === 'custom' ? 'selected' : ''} aria-label="Enter a custom payment amount" aria-pressed={selected === 'custom'} aria-expanded={selected === 'custom'} aria-controls="custom-amount-fields" disabled={!config.custom_topup_enabled} onClick={() => setSelected('custom')}><strong>Custom amount</strong><span>{config.custom_topup_enabled ? 'Enter whole rupees' : 'Unavailable'}</span></button></div>
      {selected === 'custom' && <div id="custom-amount-fields" className="custom-amount-fields"><label htmlFor="custom-topup-rupees">Custom amount</label><div className="inr-input"><span aria-hidden="true">₹</span><input id="custom-topup-rupees" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" value={customInput} onChange={event => changeCustomInput(event.target.value)} aria-describedby={`custom-amount-help${custom.error ? ' custom-amount-error' : ''}`} aria-invalid={custom.paise === null} /></div><small id="custom-amount-help">Minimum {packageRupees(config.min_topup_paise)} · Maximum {packageRupees(config.max_topup_paise)}</small>{custom.error && <p id="custom-amount-error" className="custom-amount-error" role="alert">{custom.error}</p>}{custom.paise !== null && estimateState === 'loading' && <p className="custom-estimate-state" role="status">Calculating estimate…</p>}{estimateState === 'error' && <p className="custom-amount-error" role="alert">Token estimate is unavailable. Try again.</p>}</div>}
      {selectedAmountPaise !== null && selectedEstimateReady && <div className="package-summary"><strong>Pay {packageRupees(selectedAmountPaise)} for {bucket === 'chat' ? 'Chat' : 'Voice'} credits</strong>{bucket === 'chat' ? <span>Estimated token range <strong>{estimateRange(selectedTokenEstimate)}</strong></span> : <><span>STT-only component estimate <strong>{selectedVoiceEstimate?.estimated_stt_minutes} minutes</strong></span><span>TTS-only component estimate <strong>{selectedVoiceEstimate?.estimated_tts_characters.toLocaleString()} characters</strong></span><small>Realtime Voice also uses Voice credits for AI response generation. These component-only estimates do not guarantee complete conversations. {selectedVoiceEstimate?.assumption}</small></>}</div>}
      {!config.checkout_enabled && <p className="checkout-disabled" role="status">Checkout is currently disabled. Existing Chat and Voice credits can still be used.</p>}
      <button className="primary wide" disabled={busy || !checkoutReady || !config.checkout_enabled} onClick={() => void checkout()}>{payButtonLabel}</button>
      {status && <p className="payment-status" role="status" aria-live="polite">{status}</p>}</>}
    </section>
  </div>
}
