import { useEffect, useState } from 'react'
import type { User } from 'firebase/auth'
import { apiJson } from '../api/client'
import type { BillingConfig, BillingPackage } from '../types'
import { loadRazorpay } from './razorpay'

type Order = { key_id: string; provider_order_id: string; amount: number; currency: string; internal_order_id: string; credited_amount_micros: number; platform_share_paise: number }

export function BillingModal({ user, config, close, refreshed }: { user: User; config: BillingConfig; close: () => void; refreshed: () => void }) {
  const [selected, setSelected] = useState<BillingPackage | null>(config.packages[0] ?? null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'topup' | 'history'>('topup')
  const [history, setHistory] = useState<Array<{ id: string; label: string; detail: string }>>([])
  useEffect(() => { document.querySelector<HTMLButtonElement>('.billing-modal button')?.focus() }, [])
  useEffect(() => {
    void Promise.all([
      apiJson<{ items: Array<{ id: string; entry_type: string; amount_micros: number; created_at: string }> }>(user, '/api/web/billing/ledger'),
      apiJson<{ items: Array<{ id: string; gross_amount_paise: number; status: string; created_at: string }> }>(user, '/api/web/billing/payments'),
    ]).then(([ledger, payments]) => setHistory([
      ...ledger.items.map(item => ({ id: `l-${item.id}`, label: item.entry_type.replaceAll('_', ' '), detail: `${item.amount_micros >= 0 ? '+' : ''}₹${(item.amount_micros / 1_000_000).toFixed(4)} · ${new Date(item.created_at).toLocaleDateString()}` })),
      ...payments.items.map(item => ({ id: `p-${item.id}`, label: `Payment · ${item.status}`, detail: `₹${(item.gross_amount_paise / 100).toFixed(2)} · ${new Date(item.created_at).toLocaleDateString()}` })),
    ])).catch(() => undefined)
  }, [user])

  const checkout = async () => {
    if (!selected) return
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
          setStatus(verified.credited ? 'Credit added.' : 'Payment confirmation pending.')
          refreshed(); setBusy(false)
        })().catch(() => { setStatus('Payment confirmation pending. Your credit will update after the provider webhook.'); setBusy(false) }) },
      })
      checkoutInstance.on('payment.failed', () => { setStatus('Payment failed. No credit was added.'); setBusy(false) })
      checkoutInstance.open()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Order creation failed. Checkout was not opened.')
      setBusy(false)
    }
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <section className="billing-modal" role="dialog" aria-modal="true" aria-labelledby="billing-title">
      <button className="modal-close" aria-label="Close add credit" onClick={close}>×</button>
      <span className="eyebrow">AI credits</span><h2 id="billing-title">Keep the conversation flowing</h2>
      <div className="billing-tabs"><button className={tab === 'topup' ? 'active' : ''} onClick={() => setTab('topup')}>Add credit</button><button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>History</button></div>
      {tab === 'history' ? <div className="billing-history">{history.length ? history.map(item => <div key={item.id}><strong>{item.label}</strong><span>{item.detail}</span></div>) : <p>No payment or usage history yet.</p>}</div> : <>
      <p>Choose a prepaid package. Credits pay only for AI usage and are not withdrawable cash.</p>
      <div className="packages">{config.packages.map(item => <button key={item.gross_amount_paise} className={selected === item ? 'selected' : ''} onClick={() => setSelected(item)}>
        <strong>₹{item.gross_amount_paise / 100}</strong>
        <span>Receive ₹{item.credited_amount_micros / 1_000_000} AI usage credit</span>
      </button>)}</div>
      {selected && <div className="allocation">
        <span>You pay <strong>₹{selected.gross_amount_paise / 100}</strong></span>
        <span>AI credits <strong>₹{selected.credited_amount_micros / 1_000_000}</strong></span>
        <span>Service/platform allocation <strong>₹{selected.platform_share_paise / 100}</strong></span>
      </div>}
      <button className="primary wide" disabled={busy || !selected} onClick={() => void checkout()}>{busy ? 'Please wait…' : selected ? `Pay ₹${selected.gross_amount_paise / 100} securely` : 'Choose a package'}</button>
      {status && <p className="payment-status" role="status">{status}</p>}
      </>}
    </section>
  </div>
}
