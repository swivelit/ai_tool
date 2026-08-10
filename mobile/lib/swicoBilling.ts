import type { BillingConfig, Bootstrap, CreditBucket, PaymentHistory, PaymentStatus, TopupEstimateResponse, Wallet } from "./swicoTypes";

export type BillingSelection = "preset-1500" | "preset-29900" | "custom";

export function formatRupeesFromPaise(paise: number) {
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function customTopupAmount(value: string, config: BillingConfig) {
  if (!value) return { paise: null as number | null, error: null as string | null };
  if (!/^\d+$/.test(value)) return { paise: null, error: "Enter a whole-rupee amount using numbers only." };
  const rupees = Number(value);
  const paise = rupees * 100;
  if (!Number.isSafeInteger(rupees) || !Number.isSafeInteger(paise)) return { paise: null, error: "Enter a valid whole-rupee amount." };
  if (paise < config.min_topup_paise || paise > config.max_topup_paise) {
    return { paise: null, error: `Enter an amount from ${formatRupeesFromPaise(config.min_topup_paise)} to ${formatRupeesFromPaise(config.max_topup_paise)}.` };
  }
  return { paise, error: null };
}

export function tokenRangeLabel(estimate: { range_min_tokens: number; range_max_tokens: number } | null | undefined) {
  if (!estimate) return "Estimate unavailable";
  return `${estimate.range_min_tokens.toLocaleString()}–${estimate.range_max_tokens.toLocaleString()} tokens`;
}

export function voiceEstimateLabel(estimate: NonNullable<TopupEstimateResponse["voice_estimate"]> | undefined | null) {
  return estimate
    ? `About ${estimate.estimated_stt_minutes} STT-only min or ${estimate.estimated_tts_characters.toLocaleString()} TTS-only characters`
    : "Estimate unavailable";
}

export function paymentStatusLabel(payment: Pick<PaymentHistory, "status" | "credit_applied" | "payment_received"> | Pick<PaymentStatus, "status">) {
  if (("credit_applied" in payment && payment.credit_applied) || payment.status === "credited") return "Credited";
  if (payment.status === "failed") return "Failed — no credits added";
  if (["cancelled", "canceled"].includes(payment.status)) return "Cancelled";
  if (payment.status === "refunded" || payment.status === "partially_refunded") return "Refunded";
  if (["reversed", "reversal", "credit_reversed", "partially_reversed"].includes(payment.status)) return "Credit reversal";
  if (["payment_received", "credit_pending"].includes(payment.status)) return "Payment received — credit pending";
  if (("payment_received" in payment && payment.payment_received) || payment.status === "pending") return "Pending confirmation";
  return payment.status.replaceAll("_", " ");
}

export function selectedBillingAmount(selection: BillingSelection, customInput: string, config: BillingConfig) {
  if (selection === "custom") return customTopupAmount(customInput, config).paise;
  const amount = selection === "preset-1500" ? 1500 : 29900;
  return config.packages.some(item => item.gross_amount_paise === amount) ? amount : null;
}

export function creditBucketLabel(bucket: CreditBucket) { return bucket === "voice" ? "Voice" : "Chat"; }

export function applyAuthoritativeVoiceWallet(bootstrap: Bootstrap, wallet: Wallet): Bootstrap {
  return {
    ...bootstrap,
    ...(!bootstrap.wallets || wallet.credit_bucket === "chat" ? { wallet } : {}),
    ...(bootstrap.wallets ? { wallets: { ...bootstrap.wallets, voice: wallet } } : {}),
  };
}
