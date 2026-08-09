import { describe, expect, it } from "vitest";
import { customTopupAmount, paymentStatusLabel, selectedBillingAmount, tokenRangeLabel } from "../lib/swicoBilling";
import { repositoryDetachCode, repositoryExpired, repositoryUsable } from "../lib/swicoRepository";
import type { BillingConfig } from "../lib/swicoTypes";
import { emptySwicoStreamState, reduceSwicoStream } from "../lib/swicoChatReducer";
import { assistantActionsEnabled, hasSendableContent, latestEditableUserId } from "../lib/swicoMessageEligibility";
import { messageIndexForSearch } from "../lib/swicoNavigation";
import { VoiceReplyCache, needsVoiceSynthesis } from "../lib/swicoVoiceReply";
import type { Message } from "../lib/swicoTypes";

const config: BillingConfig = {
  currency: "INR", credit_percent: "50", min_topup_paise: 1000, max_topup_paise: 50000,
  razorpay_mode: "test", checkout_enabled: true, custom_topup_enabled: true,
  packages: [{ gross_amount_paise: 1500, credited_amount_micros: 500000, platform_share_paise: 500, token_estimate: { tier: "standard", tier_label: "Swico", pricing_as_of: "now", estimated_blended_tokens: 1000, range_min_tokens: 800, range_max_tokens: 1200, explanation: "server" } }],
};

describe("mobile parity contracts", () => {
  it("preserves configured billing amounts and validates custom rupees", () => {
    expect(selectedBillingAmount("preset-1500", "", config)).toBe(1500);
    expect(customTopupAmount("25", config)).toEqual({ paise: 2500, error: null });
    expect(customTopupAmount("9", config).error).toContain("₹10");
    expect(tokenRangeLabel(config.packages[0].token_estimate)).toBe("800–1,200 tokens");
  });

  it("maps late payment states without inventing client-side credit", () => {
    expect(paymentStatusLabel({ status: "pending", payment_received: true, credit_applied: false })).toBe("Pending confirmation");
    expect(paymentStatusLabel({ status: "credited", payment_received: true, credit_applied: true })).toBe("Credited");
    expect(paymentStatusLabel({ status: "failed", payment_received: false, credit_applied: false })).toContain("Failed");
  });

  it("requires repository owner, thread, ready state, and unexpired server metadata", () => {
    const base = { id: "r", display_name: "repo.zip", source_version: "1", content_hash: "h", file_count: 1, symbol_count: 1, status: "ready", created_at: "", expires_at: new Date(Date.now() + 60_000).toISOString(), languages: [], frameworks: [], owner_uid: "u", thread_id: "t" };
    expect(repositoryUsable(base, "u", "t")).toBe(true);
    expect(repositoryUsable(base, "other", "t")).toBe(false);
    expect(repositoryUsable(base, "u", "other")).toBe(false);
    expect(repositoryExpired({ status: "ready", expires_at: new Date(Date.now() - 1).toISOString() })).toBe(true);
    expect(repositoryDetachCode("repository_not_found")).toBe(true);
  });

  it("keeps retry_at and retryable status in the stream projection", () => {
    const state = reduceSwicoStream({ ...emptySwicoStreamState, assistant: { id: "a", thread_id: "t", role: "assistant", content: "", request_id: "r", tier: "standard", tier_label: "Swico", input_tokens: 0, output_tokens: 0, usage_source: null, charge_micros: 0, status: "streaming", created_at: "", input_mode: "text", voice_turn_id: null, reply_language: "en" } }, { event: "error", data: { code: "capacity", message: "Try later", retryable: true, retry_at: "2030-01-01T00:00:00Z" } });
    expect(state.assistant?.status).toBe("retryable");
    expect(state.error?.retry_at).toBe("2030-01-01T00:00:00Z");
  });

  it("keeps payment status separate from history rows", async () => {
    const status: import("../lib/swicoTypes").PaymentStatus = { internal_order_id: "ord_1", gross_amount_paise: 1500, credited_amount_micros: 500000, platform_share_paise: 500, refunded_amount_paise: 0, status: "credited", provider_payment_id: "pay_1", created_at: "", paid_at: "", refunded_at: null, updated_at: "" };
    expect(status.internal_order_id).toBe("ord_1");
    expect("id" in status).toBe(false);
  });

  it("keeps sendability and latest-user edit rules aligned with web semantics", () => {
    const message = (overrides: Partial<Message>): Message => ({ id: "m", thread_id: "t", role: "user", content: "hello", request_id: "r", tier: "standard", tier_label: "Swico", input_tokens: 0, output_tokens: 0, usage_source: null, charge_micros: 0, status: "complete", created_at: "", input_mode: "text", voice_turn_id: null, reply_language: "en", ...overrides });
    const older = message({ id: "older" });
    const latest = message({ id: "latest" });
    expect(latestEditableUserId([older, latest], false)).toBe("latest");
    expect(latestEditableUserId([older, latest], true)).toBeNull();
    expect(hasSendableContent("", [{ id: "a", name: "a.txt", media_type: "text/plain", size_bytes: 1, created_at: "", expires_at: "2099-01-01", warnings: [], status: "ready" }], false)).toBe(true);
    expect(hasSendableContent("", [], true)).toBe(true);
  });

  it("gates assistant actions and requires a real voice turn id", () => {
    const base: Message = { id: "a", thread_id: "t", role: "assistant", content: "ok", request_id: "r", tier: "standard", tier_label: "Swico", input_tokens: 0, output_tokens: 0, usage_source: null, charge_micros: 0, status: "complete", created_at: "", input_mode: "voice", voice_turn_id: null, reply_language: "en" };
    expect(assistantActionsEnabled({ ...base, status: "streaming" }, true, true).completed).toBe(false);
    expect(assistantActionsEnabled({ ...base, voice_turn_id: "" }, true, true).voice).toBe(false);
    expect(assistantActionsEnabled({ ...base, voice_turn_id: "turn_1" }, true, true).voice).toBe(true);
    expect(assistantActionsEnabled(base, false, true).feedback).toBe(false);
  });

  it("replays cached voice without requesting synthesis again", () => {
    const cache = new VoiceReplyCache<{ play: () => void }>(2);
    expect(needsVoiceSynthesis("idle", Boolean(cache.get("message")))).toBe(true);
    cache.set("message", { uri: "file://reply.m4a", sound: { play: () => undefined } });
    expect(needsVoiceSynthesis("ended", Boolean(cache.get("message")))).toBe(false);
    expect(cache.get("message")?.uri).toBe("file://reply.m4a");
  });

  it("finds a selected search result instead of defaulting to the list tail", () => {
    const messages = [{ id: "one" }, { id: "target" }, { id: "three" }] as Message[];
    expect(messageIndexForSearch(messages, "target")).toBe(1);
    expect(messageIndexForSearch(messages, "missing")).toBe(-1);
  });
});
