export type Wallet = { balance_micros: number; reserved_micros: number; available_micros: number; version: number }
export type Thread = { id: string; title: string; archived_at: string | null; created_at: string; updated_at: string }
export type Message = {
  id: string; thread_id: string; role: 'user' | 'assistant' | 'system'; content: string;
  request_id: string | null; provider: string | null; model: string | null;
  input_tokens: number; output_tokens: number; usage_source: 'actual' | 'estimated' | null;
  charge_micros: number; status: string; created_at: string;
}
export type BillingPackage = { gross_amount_paise: number; credited_amount_micros: number; platform_share_paise: number }
export type BillingConfig = {
  currency: 'INR'; credit_percent: string; razorpay_key_id: string; min_topup_paise: number;
  max_topup_paise: number; packages: BillingPackage[];
}
export type Bootstrap = {
  user: { id: number; name: string; email: string | null; reply_language: string };
  wallet: Wallet; billing: BillingConfig;
  features: { web_chat: boolean; prepaid_billing: boolean; local_models: false };
}
export type StreamEventName = 'thread' | 'status' | 'delta' | 'usage' | 'wallet' | 'done' | 'error'
export type SSEEvent = { event: StreamEventName | (string & {}); data: unknown }
export type PaymentStatus = {
  internal_order_id: string; gross_amount_paise: number; credited_amount_micros: number;
  platform_share_paise: number; refunded_amount_paise: number; status: string;
  provider_payment_id: string | null; created_at: string; paid_at: string | null;
  refunded_at: string | null; updated_at: string;
}
