export type Wallet = { balance_micros: number; reserved_micros: number; available_micros: number; version: number; token_estimate?: TokenEstimate }
export type Thread = { id: string; title: string; archived_at: string | null; created_at: string; updated_at: string }
export type Message = {
  id: string; thread_id: string; role: 'user' | 'assistant' | 'system'; content: string;
  request_id: string | null; provider: string | null; model: string | null;
  input_tokens: number; output_tokens: number; usage_source: 'actual' | 'estimated' | null;
  charge_micros: number; status: string; created_at: string;
}
export type BillingPackage = { gross_amount_paise: number; credited_amount_micros: number; platform_share_paise: number; token_estimate?: TokenEstimate }
export type BillingConfig = {
  currency: 'INR'; credit_percent: string; razorpay_key_id: string; min_topup_paise: number;
  razorpay_mode: 'test' | 'live'; checkout_enabled: boolean;
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

export type ProfileSettings = {
  name: string; place: string | null; timezone: string; assistant_name: string;
  reply_language: 'en' | 'ta'; email: string | null; email_editable: false;
}
export type UsagePreferences = {
  period: 'monthly'; hard_limit_micros: number | null; hard_limit_ai_credits: string | null;
  warning_threshold_percent: number; notify_at_threshold: boolean;
  current_usage_micros: number; current_usage_ai_credits: string;
  remaining_micros: number | null; warning_reached: boolean;
  hard_limit_token_estimate: TokenEstimate | null; remaining_token_estimate: TokenEstimate | null;
  next_reset_at: string; timezone: string; updated_at: string | null;
}
export type UsageBreakdown = {
  provider: string; model?: string; request_count: number; input_tokens: number;
  cached_input_tokens: number; output_tokens: number; total_tokens: number;
  debited_micros: number; debited_ai_credits: string;
}
export type TokenEstimate = {
  reference_provider: string; reference_model: string; pricing_as_of: string;
  pricing_snapshot: Record<string, unknown>; estimated_input_only_tokens: number;
  estimated_output_only_tokens: number; estimated_blended_tokens: number | null;
  blended_assumption?: string; range_min_tokens: number; range_max_tokens: number;
  explanation: string;
}
export type UsageSummary = {
  period: 'current_month' | '30d' | 'all'; timezone: string;
  period_start: string; period_end: string; next_reset_at: string | null;
  request_count: number; input_tokens: number; cached_input_tokens: number;
  output_tokens: number; total_tokens: number; actual_usage_count: number;
  estimated_usage_count: number; debited_micros: number; debited_ai_credits: string;
  available_micros: number; available_ai_credits: string;
  daily: Array<{ date: string } & Omit<UsageBreakdown, 'provider' | 'model'>>;
  provider_breakdown: UsageBreakdown[]; model_breakdown: UsageBreakdown[];
  estimated_tokens_remaining: TokenEstimate;
}
export type PaymentHistory = {
  id: string; gross_amount_paise: number; credited_amount_micros: number;
  platform_share_paise: number; refunded_amount_paise: number;
  credit_reversal_micros: number; status: string; created_at: string;
  token_estimate?: TokenEstimate; reversal_token_estimate?: TokenEstimate;
}
