import { useEffect, useRef, useState } from 'react'
import { ShieldCheck, X } from 'lucide-react'
import type { User } from 'firebase/auth'
import { apiJson } from '../api/client'
import { formatAiCredits, formatRupeesFromPaise } from '../credits'
import type { BillingConfig, BillingPackage, PaymentHistory } from '../types'
import { loadRazorpay } from './razorpay'
import { pollPaymentStatus } from './paymentPolling'

type Order = { key_id: string; provider_order_id: string; amount: number; currency: string; internal_order_id: string; credited_amount_micros: number; platform_share_paise: number }

function packageRupees(paise: number) {
  return paise % 100 === 0 ? `₹${paise / 100}` : formatRupeesFromPaise(paise)
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
    if (final.status === 'credited') { await Promise.resolve(refreshed()); setStatus('AI credits added.'); closeSoon(); return }
    setStatus(final.status === 'failed' ? 'Payment failed. No AI credits were added.' : `Payment status: ${final.status.replaceAll('_', ' ')}.`)
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
        name: 'Swico', description: 'Prepaid AI credits', modal: { ondismiss: () => { setBusy(false); setStatus('Payment cancelled — no AI credits were added.') } },
        handler: result => { void (async () => {
          setStatus('Confirming payment…')
          const verified = await apiJson<{ status: string; credited: boolean }>(user, '/api/web/billing/verify', {
            method: 'POST', body: JSON.stringify({ internal_order_id: order.internal_order_id, ...result }),
          })
          if (verified.credited) { refreshed(); setStatus('AI credits added.'); closeSoon() }
          else await finishPending(order.internal_order_id)
          setBusy(false)
        })().catch(async () => { await finishPending(order.internal_order_id).catch(() => setStatus('Payment confirmation is pending.')); setBusy(false) }) },
      })
      checkoutInstance.on('payment.failed', () => { setStatus('Payment failed. No AI credits were added.'); setBusy(false) })
      checkoutInstance.open()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Order creation failed. Checkout was not opened.'); setBusy(false)
    }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close() }}>
    <section ref={dialogRef} className="billing-modal" role="dialog" aria-modal="true" aria-labelledby="billing-title" aria-describedby="billing-description">
      <button ref={closeRef} className="modal-close icon-button" aria-label="Close add credit" title="Close" disabled={busy} onClick={close}><X size={20} /></button>
      <div className="modal-heading"><span className="modal-icon"><ShieldCheck size={21} /></span><div><h2 id="billing-title">Add AI credits</h2><p>Secure prepaid usage for Swico</p></div>{testMode && <strong className="test-mode">Test Mode</strong>}</div>
      <div className="billing-tabs" role="tablist" aria-label="Billing"><button role="tab" aria-selected={tab === 'topup'} className={tab === 'topup' ? 'active' : ''} onClick={() => setTab('topup')}>Add credits</button><button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>Payment history</button></div>
      {tab === 'history' ? <div className="billing-history" aria-live="polite">
        {historyState === 'loading' && <p>Loading payment history…</p>}
        {historyState === 'error' && <p role="alert">Payment history could not be loaded.</p>}
        {historyState === 'ready' && !history.length && <p>No payments or refunds yet.</p>}
        {history.map(item => <article key={item.id}><header><strong>{formatRupeesFromPaise(item.gross_amount_paise)} paid</strong><span>{item.status.replaceAll('_', ' ')}</span></header><dl>
          <div><dt>Gross amount paid</dt><dd>{formatRupeesFromPaise(item.gross_amount_paise)}</dd></div>
          <div><dt>AI credits granted</dt><dd>{formatAiCredits(item.credited_amount_micros)} AI credits</dd></div>
          <div><dt>Platform allocation</dt><dd>{formatRupeesFromPaise(item.platform_share_paise)}</dd></div>
          <div><dt>Refund amount</dt><dd>{formatRupeesFromPaise(item.refunded_amount_paise)}</dd></div>
          <div><dt>Credit reversal</dt><dd>{formatAiCredits(item.credit_reversal_micros)} AI credits</dd></div>
        </dl><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleDateString()}</time></article>)}
      </div> : <>
      <p id="billing-description" title="AI credits are non-transferable, non-withdrawable, and can only be used for AI usage on Swico.">AI credits are non-transferable, non-withdrawable, and can only be used for AI usage on Swico.</p>
      <div className="packages">{config.packages.map(item => <button key={item.gross_amount_paise} className={selected === item ? 'selected' : ''} aria-pressed={selected === item} onClick={() => setSelected(item)}><strong>{packageRupees(item.gross_amount_paise)}</strong><span>Receive {formatAiCredits(item.credited_amount_micros)} AI credits</span></button>)}</div>
      {selected && <div className="allocation"><strong className="package-summary">Pay {packageRupees(selected.gross_amount_paise)} → receive {formatAiCredits(selected.credited_amount_micros)} AI credits</strong><span>Amount paid <strong>{formatRupeesFromPaise(selected.gross_amount_paise)}</strong></span><span>Usage-value equivalent <strong>{formatRupeesFromPaise(Math.floor(selected.credited_amount_micros / 10_000))}</strong></span><span>Platform allocation <strong>{formatRupeesFromPaise(selected.platform_share_paise)}</strong></span><small>Equivalent to ₹{Math.floor(selected.credited_amount_micros / 1_000_000)} of consumable AI usage</small></div>}
      {!config.checkout_enabled && <p className="checkout-disabled" role="status">Checkout is currently disabled. Existing AI credits can still be used.</p>}
      <button className="primary wide" disabled={busy || !selected || !config.checkout_enabled} onClick={() => void checkout()}>{busy ? 'Please wait…' : selected ? `Pay ${packageRupees(selected.gross_amount_paise)} securely` : 'Choose a package'}</button>
      {status && <p className="payment-status" role="status" aria-live="polite">{status}</p>}</>}
    </section>
  </div>
}
