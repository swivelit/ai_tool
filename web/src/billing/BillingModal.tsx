import { useEffect, useRef, useState } from 'react'
import { ShieldCheck, X } from 'lucide-react'
import type { User } from 'firebase/auth'
import { apiJson } from '../api/client'
import { formatRupeesFromPaise, tokenRangeLabel } from '../credits'
import type { BillingConfig, BillingPackage, PaymentHistory } from '../types'
import { loadRazorpay } from './razorpay'
import { pollPaymentStatus } from './paymentPolling'
import { paymentPresentation } from './paymentPresentation'

type Order = { key_id: string; provider_order_id: string; amount: number; currency: string; internal_order_id: string; credited_amount_micros: number; platform_share_paise: number }

function packageRupees(paise: number) {
  return paise % 100 === 0 ? `₹${paise / 100}` : formatRupeesFromPaise(paise)
}

function estimateRange(estimate: BillingPackage['token_estimate']) {
  return estimate ? tokenRangeLabel(estimate.range_min_tokens, estimate.range_max_tokens) : 'Estimate unavailable'
}

export function BillingModal({ user, config, close, refreshed }: { user: User; config: BillingConfig; close: () => void; refreshed: () => void }) {
  const [selected, setSelected] = useState<BillingPackage | null>(config.packages[0] ?? null)
  const [status, setStatus] = useState(''); const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'topup' | 'history'>('topup')
  const [history, setHistory] = useState<PaymentHistory[]>([])
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading')
  const dialogRef = useRef<HTMLElement>(null); const closeRef = useRef<HTMLButtonElement>(null)
  const closeTimer = useRef<number | null>(null); const polling = useRef<AbortController | null>(null)
  const testMode = config.razorpay_mode === 'test'
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

  const closeSoon = () => { closeTimer.current = window.setTimeout(close, 500) }
  const finishPending = async (internalOrderId: string) => {
    setStatus('Payment received. Waiting for secure confirmation…')
    polling.current?.abort(); polling.current = new AbortController()
    const final = await pollPaymentStatus(user, internalOrderId, 2000, 30000, polling.current.signal)
    if (!final) { setStatus('Confirmation is still pending. Your balance will update automatically after the webhook arrives.'); return }
    if (final.status === 'credited') { await Promise.resolve(refreshed()); setStatus('Token credits added.'); closeSoon(); return }
    setStatus(final.status === 'failed' ? 'Payment failed. No token credits were added.' : `Payment status: ${final.status.replaceAll('_', ' ')}.`)
  }

  const checkout = async () => {
    if (!selected || busy || !config.checkout_enabled) return
    setBusy(true); setStatus('Creating secure order…')
    try {
      const order = await apiJson<Order>(user, '/api/web/billing/orders', {
        method: 'POST', body: JSON.stringify({ gross_amount_paise: selected.gross_amount_paise, idempotency_key: crypto.randomUUID() }),
      })
      await loadRazorpay()
      if (!window.Razorpay) throw new Error('Checkout unavailable')
      setStatus('')
      const checkoutInstance = new window.Razorpay({
        key: order.key_id, amount: order.amount, currency: order.currency, order_id: order.provider_order_id,
        name: 'Swico', description: 'Prepaid token credits', modal: { ondismiss: () => { setBusy(false); setStatus('Payment cancelled — no token credits were added.') } },
        handler: result => { void (async () => {
          setStatus('Confirming payment…')
          const verified = await apiJson<{ status: string; credited: boolean }>(user, '/api/web/billing/verify', {
            method: 'POST', body: JSON.stringify({ internal_order_id: order.internal_order_id, ...result }),
          })
          if (verified.credited) { refreshed(); setStatus('Token credits added.'); closeSoon() }
          else await finishPending(order.internal_order_id)
          setBusy(false)
        })().catch(async () => { await finishPending(order.internal_order_id).catch(() => setStatus('Payment confirmation is pending.')); setBusy(false) }) },
      })
      checkoutInstance.on('payment.failed', () => { setStatus('Payment failed. No token credits were added.'); setBusy(false) })
      checkoutInstance.open()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Order creation failed. Checkout was not opened.'); setBusy(false)
    }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close() }}>
    <section ref={dialogRef} className="billing-modal" role="dialog" aria-modal="true" aria-labelledby="billing-title" aria-describedby="billing-description">
      <button ref={closeRef} className="modal-close icon-button" aria-label="Close add token credits" title="Close" disabled={busy} onClick={close}><X size={20} /></button>
      <div className="modal-heading"><span className="modal-icon"><ShieldCheck size={21} /></span><div><h2 id="billing-title">Add token credits</h2><p>Secure prepaid usage for Swico</p></div>{testMode && <strong className="test-mode">Test Mode</strong>}</div>
      <div className="billing-tabs" role="tablist" aria-label="Billing"><button role="tab" aria-selected={tab === 'topup'} className={tab === 'topup' ? 'active' : ''} onClick={() => setTab('topup')}>Add tokens</button><button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>Payment history</button></div>
      {tab === 'history' ? <div className="billing-history" aria-live="polite">
        {historyState === 'loading' && <p>Loading payment history…</p>}
        {historyState === 'error' && <p role="alert">Payment history could not be loaded.</p>}
        {historyState === 'ready' && !history.length && <p>No payments or refunds yet.</p>}
        {history.map(item => { const presentation = paymentPresentation(item); return <article key={item.id}><header><strong>{presentation.heading}</strong>{presentation.detail && <span>{presentation.detail}</span>}</header><dl>
          {presentation.amountLabel && <div><dt>{presentation.amountLabel}</dt><dd>{formatRupeesFromPaise(item.gross_amount_paise)}</dd></div>}
          {presentation.showTokensAdded && <div><dt>Estimated tokens added</dt><dd>{estimateRange(item.token_estimate)}</dd></div>}
          {presentation.showServiceAllocation && <div><dt>Service allocation</dt><dd>{config.credit_percent}%</dd></div>}
          {presentation.showRefundAmount && <div><dt>Refund amount</dt><dd>{formatRupeesFromPaise(item.refunded_amount_paise)}</dd></div>}
          {presentation.showReversalEstimate && <div><dt>Estimated tokens reversed</dt><dd>{estimateRange(item.reversal_token_estimate)}</dd></div>}
        </dl><span>{presentation.timestampLabel} <time dateTime={presentation.timestamp}>{new Date(presentation.timestamp).toLocaleDateString()}</time></span></article> })}
      </div> : <>
      <p id="billing-description">Token estimates are approximate for your selected Swico mode and do not guarantee a fixed amount.</p>
      <div className="packages">{config.packages.map(item => <button key={item.gross_amount_paise} className={selected === item ? 'selected' : ''} aria-pressed={selected === item} onClick={() => setSelected(item)}><strong>Pay {packageRupees(item.gross_amount_paise)}</strong><span>{config.credit_percent}% converted to token credits</span><span>{estimateRange(item.token_estimate)}</span></button>)}</div>
      {selected && <div className="allocation"><strong className="package-summary">Pay {packageRupees(selected.gross_amount_paise)}</strong><span>Converted to token credits <strong>{config.credit_percent}%</strong></span><span>Estimated token range <strong>{estimateRange(selected.token_estimate)}</strong></span><span>Service and platform allocation <strong>{100 - Number(config.credit_percent)}%</strong></span><small>{selected.token_estimate ? <>{selected.token_estimate.explanation} Pricing as of {new Date(selected.token_estimate.pricing_as_of).toLocaleString()}.</> : 'Token estimation is temporarily unavailable.'}</small></div>}
      {!config.checkout_enabled && <p className="checkout-disabled" role="status">Checkout is currently disabled. Existing token credits can still be used.</p>}
      <button className="primary wide" disabled={busy || !selected || !config.checkout_enabled} onClick={() => void checkout()}>{busy ? 'Please wait…' : selected ? `Pay ${packageRupees(selected.gross_amount_paise)} securely` : 'Choose a package'}</button>
      {status && <p className="payment-status" role="status" aria-live="polite">{status}</p>}</>}
    </section>
  </div>
}
