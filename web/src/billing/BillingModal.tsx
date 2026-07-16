import { useEffect, useRef, useState } from 'react'
import { ShieldCheck, X } from 'lucide-react'
import type { User } from 'firebase/auth'
import { apiJson } from '../api/client'
import type { BillingConfig, BillingPackage } from '../types'
import { loadRazorpay } from './razorpay'
import { pollPaymentStatus } from './paymentPolling'

type Order = { key_id: string; provider_order_id: string; amount: number; currency: string; internal_order_id: string; credited_amount_micros: number; platform_share_paise: number }

export function BillingModal({ user, config, close, refreshed }: { user: User; config: BillingConfig; close: () => void; refreshed: () => void }) {
  const [selected, setSelected] = useState<BillingPackage | null>(config.packages[0] ?? null)
  const [status, setStatus] = useState(''); const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'topup' | 'history'>('topup')
  const [history, setHistory] = useState<Array<{ id: string; label: string; detail: string }>>([])
  const dialogRef = useRef<HTMLElement>(null); const closeRef = useRef<HTMLButtonElement>(null)
  const testMode = config.razorpay_key_id.startsWith('rzp_test_')
  useEffect(() => {
    closeRef.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) close()
      if (event.key === 'Tab') {
        const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a,input') ?? [])]
        if (!focusable.length) return
        const first = focusable[0]; const last = focusable[focusable.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard)
  }, [busy, close])
  useEffect(() => {
    void Promise.all([
      apiJson<{ items: Array<{ id: string; entry_type: string; amount_micros: number; created_at: string }> }>(user, '/api/web/billing/ledger'),
      apiJson<{ items: Array<{ id: string; gross_amount_paise: number; status: string; created_at: string }> }>(user, '/api/web/billing/payments'),
    ]).then(([ledger, payments]) => setHistory([
      ...ledger.items.map(item => ({ id: `l-${item.id}`, label: item.entry_type.replaceAll('_', ' '), detail: `${item.amount_micros >= 0 ? '+' : ''}₹${(item.amount_micros / 1_000_000).toFixed(4)} · ${new Date(item.created_at).toLocaleDateString()}` })),
      ...payments.items.map(item => ({ id: `p-${item.id}`, label: `Payment · ${item.status}`, detail: `₹${(item.gross_amount_paise / 100).toFixed(2)} · ${new Date(item.created_at).toLocaleDateString()}` })),
    ])).catch(() => undefined)
  }, [user])

  const finishPending = async (internalOrderId: string) => {
    setStatus('Payment received. Waiting for secure confirmation…')
    const final = await pollPaymentStatus(user, internalOrderId)
    if (!final) { setStatus('Confirmation is still pending. Your balance will update automatically after the webhook arrives.'); return }
    if (final.status === 'credited') { await Promise.resolve(refreshed()); setStatus('Credit added.'); window.setTimeout(close, 500); return }
    setStatus(final.status === 'failed' ? 'Payment failed. No credit was added.' : `Payment status: ${final.status.replaceAll('_', ' ')}.`)
  }

  const checkout = async () => {
    if (!selected || busy) return
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
        name: 'Swico', description: 'Prepaid AI usage credits', modal: { ondismiss: () => { setBusy(false); setStatus('Payment cancelled — no credit was added.') } },
        handler: result => { void (async () => {
          setStatus('Confirming payment…')
          const verified = await apiJson<{ status: string; credited: boolean }>(user, '/api/web/billing/verify', {
            method: 'POST', body: JSON.stringify({ internal_order_id: order.internal_order_id, ...result }),
          })
          if (verified.credited) { refreshed(); setStatus('Credit added.'); window.setTimeout(close, 500) }
          else await finishPending(order.internal_order_id)
          setBusy(false)
        })().catch(async () => { await finishPending(order.internal_order_id).catch(() => setStatus('Payment confirmation is pending.')); setBusy(false) }) },
      })
      checkoutInstance.on('payment.failed', () => { setStatus('Payment failed. No credit was added.'); setBusy(false) })
      checkoutInstance.open()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Order creation failed. Checkout was not opened.'); setBusy(false)
    }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close() }}>
    <section ref={dialogRef} className="billing-modal" role="dialog" aria-modal="true" aria-labelledby="billing-title">
      <button ref={closeRef} className="modal-close icon-button" aria-label="Close add credit" title="Close" disabled={busy} onClick={close}><X size={20} /></button>
      <div className="modal-heading"><span className="modal-icon"><ShieldCheck size={21} /></span><div><h2 id="billing-title">Add AI credit</h2><p>Secure prepaid usage for Swico</p></div>{testMode && <strong className="test-mode">Test Mode</strong>}</div>
      <div className="billing-tabs" role="tablist"><button role="tab" aria-selected={tab === 'topup'} className={tab === 'topup' ? 'active' : ''} onClick={() => setTab('topup')}>Add credit</button><button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>History</button></div>
      {tab === 'history' ? <div className="billing-history">{history.length ? history.map(item => <div key={item.id}><strong>{item.label}</strong><span>{item.detail}</span></div>) : <p>No payment or usage history yet.</p>}</div> : <>
      <p>Choose a package. AI credit is non-transferable, non-withdrawable, and used only for AI-service consumption.</p>
      <div className="packages">{config.packages.map(item => <button key={item.gross_amount_paise} className={selected === item ? 'selected' : ''} aria-pressed={selected === item} onClick={() => setSelected(item)}><strong>₹{item.gross_amount_paise / 100}</strong><span>₹{item.credited_amount_micros / 1_000_000} AI credit</span></button>)}</div>
      {selected && <div className="allocation"><span>You pay <strong>₹{selected.gross_amount_paise / 100}</strong></span><span>AI credit <strong>₹{selected.credited_amount_micros / 1_000_000}</strong></span><span>Platform allocation <strong>₹{selected.platform_share_paise / 100}</strong></span></div>}
      <button className="primary wide" disabled={busy || !selected} onClick={() => void checkout()}>{busy ? 'Please wait…' : selected ? `Pay ₹${selected.gross_amount_paise / 100} securely` : 'Choose a package'}</button>
      {status && <p className="payment-status" role="status">{status}</p>}</>}
    </section>
  </div>
}
