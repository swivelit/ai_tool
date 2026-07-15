export type CheckoutOptions = {
  key: string; amount: number; currency: string; order_id: string; name: string; description: string;
  handler: (result: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => void;
  modal: { ondismiss: () => void };
}

declare global {
  interface Window { Razorpay?: new (options: CheckoutOptions) => { open: () => void; on: (name: string, callback: () => void) => void } }
}

let loading: Promise<void> | null = null
export function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve()
  if (loading) return loading
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://checkout.razorpay.com/v1/checkout.js'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Payment checkout could not load'))
    document.head.appendChild(script)
  })
  return loading
}
