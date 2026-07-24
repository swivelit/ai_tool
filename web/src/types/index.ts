export type Wallet = {
  credit_bucket?: CreditBucket;
  balance_micros: number; reserved_micros: number; available_micros: number;
  version: number; token_estimate?: TokenEstimate | null;
  billing_exempt?: boolean; balance_display?: 'Unlimited';
}
export type CreditBucket = 'chat' | 'voice'
export type Wallets = { chat: Wallet; voice: Wallet }
export type SwicoTier = 'lite' | 'standard' | 'pro'
export type SwicoTierOption = {
  id: SwicoTier; label: string; description: string; available: boolean; selected: boolean;
}
export type AssistantSettings = {
  tier: SwicoTier; tier_label: string; tier_description: string;
  tier_selection_enabled: boolean; tiers: SwicoTierOption[];
}
export type Thread = { id: string; title: string; archived_at: string | null; created_at: string; updated_at: string }
export type AttachmentDisplay = {
  id: string; name: string; media_type: string; size_bytes: number;
  created_at: string; expires_at: string; warnings: string[]; warning_codes?: string[];
}
export type PendingAttachment = {
  local_id: string; file: File; name: string; media_type: string; size_bytes: number;
  status: 'uploading' | 'error'; progress: number; error?: string;
}
export type ReadyAttachment = AttachmentDisplay & { status: 'ready' }
export type ExpiredAttachment = AttachmentDisplay & { status: 'expired' | 'unavailable' }
export type MessageAttachment = ReadyAttachment | ExpiredAttachment
export type ComposerAttachment = PendingAttachment | ReadyAttachment | ExpiredAttachment
export type AudioRecorderState = {
  status: 'idle' | 'requesting' | 'recording' | 'stopping' | 'transcribing' | 'error';
  elapsed_seconds: number; mime_type: string | null; error: string | null;
}
/** `voice` is retained only for deserializing historical dictation rows. */
export type InputMode = 'text' | 'voice' | 'dictation' | 'realtime_voice'
export type Message = {
  id: string; thread_id: string; role: 'user' | 'assistant' | 'system'; content: string;
  request_id: string | null; tier: SwicoTier | null; tier_label: string;
  input_tokens: number; output_tokens: number; usage_source: 'actual' | 'estimated' | null;
  charge_micros: number; status: string; created_at: string;
  attachments?: MessageAttachment[];
  input_mode: InputMode; voice_turn_id: string | null; reply_language: 'en' | 'ta' | null;
  finish_reason?: string; truncated?: boolean; can_continue?: boolean;
  completion_status?: string;
  replaces_message_id?: string | null; revision_number?: number;
  feedback_rating?: 'up' | 'down' | null;
  provenance?: ResponseProvenance[];
}
export type ResponseProvenance = 'memory' | 'document' | 'cached_answer' | 'semantic_cache' | 'backend_tool' | 'web_search'
export type SearchResult = {
  thread_id: string | null; message_id: string | null; snippet: string;
  source_kind: 'message' | 'summary' | 'memory'; updated_at: string; rank: number;
}
export type VoiceCreditEstimate = {
  pricing_version: string; estimated_stt_seconds: number; estimated_stt_minutes: string;
  estimated_tts_characters: number; assumption: string;
}
export type BillingPackage = { gross_amount_paise: number; credited_amount_micros: number; platform_share_paise: number; token_estimate?: TokenEstimate; voice_estimate?: VoiceCreditEstimate }
export type BillingConfig = {
  currency: 'INR'; credit_percent: string; razorpay_key_id: string; min_topup_paise: number;
  razorpay_mode: 'test' | 'live'; checkout_enabled: boolean;
  max_topup_paise: number; custom_topup_enabled: boolean; packages: BillingPackage[];
}
export type Bootstrap = {
  user: { id: number; name: string; email: string | null; reply_language: string };
  wallet: Wallet; wallets?: Wallets; billing: BillingConfig; assistant: AssistantSettings;
  features: {
    web_chat: boolean; prepaid_billing: boolean;
    web_attachments: boolean; web_voice_recording: boolean;
    web_voice_reply: boolean; web_voice_billing: boolean;
    web_realtime_voice: boolean; separate_voice_credits: boolean;
    web_message_edit?: boolean; web_cross_thread_memory?: boolean; web_long_input?: boolean;
    web_answer_feedback?: boolean; web_content_search?: boolean; web_response_provenance?: boolean;
  };
  backend_release?: string;
  voice_protocol_version?: number;
  voice_tuning?: VoiceTuning;
  uploads: {
    available: boolean; ttl_seconds: number; max_file_bytes: number;
    max_files_per_message: number; max_total_bytes: number; supported_extensions: string[];
    long_input_enabled?: boolean; long_input_inline_threshold_chars?: number;
    long_input_max_chars?: number;
  };
}
export type LongInputMode = 'summarize' | 'analyze' | 'ask_questions' | 'rewrite' | 'translate'
export type VoiceTuning = {
  calibration_ms: number; noise_multiplier: number; threshold_min: number;
  threshold_max: number; quiet_fallback: number; no_speech_warning_ms: number;
}
export type RealtimeVoicePlaybackMode = 'buffered_mp3' | 'pcm_stream' | 'auto'
export type RealtimeVoiceCodec = 'mp3' | 'linear16'
export type RealtimeVoiceSession = {
  protocol_version: 1; session_id: string; ticket: string; websocket_url: string;
  tier: SwicoTier; tier_label: string; language: 'en' | 'ta'; wallets: Wallets;
  playback_mode: RealtimeVoicePlaybackMode; selected_codec: RealtimeVoiceCodec;
  provider_sample_rate: number | null; media_source_allowed: boolean;
}
export type StreamEventName = 'thread' | 'status' | 'delta' | 'usage' | 'wallet' | 'done' | 'error'
export type SSEEvent = { event: StreamEventName | (string & {}); data: unknown }
export type PaymentStatus = {
  credit_bucket?: CreditBucket;
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
  tier: SwicoTier; tier_label: string;
  billing_exempt?: boolean;
}
export type MemoryFact = {
  id: string; value_text: string; category: string; created_at: string; updated_at: string;
}
export type MemorySettings = { available: boolean; enabled: boolean; items: MemoryFact[] }
export type UsageBreakdown = {
  request_count: number; input_tokens: number;
  cached_input_tokens: number; output_tokens: number; total_tokens: number;
  debited_micros: number; debited_ai_credits: string;
}
export type TierUsageBreakdown = UsageBreakdown & {
  label: string; debited_token_credits: string;
  period_debit_percentage: number; monthly_limit_percentage: number;
  utilization_percentage?: number; utilization_basis?: 'monthly_hard_limit' | 'available_plus_period_debit';
}
export type VoiceUsageBreakdown = {
  label: 'Voice'; stt_request_count: number; tts_request_count: number;
  llm_request_count: number; llm_input_tokens: number; llm_cached_input_tokens: number;
  llm_output_tokens: number; llm_total_tokens: number;
  total_audio_seconds: number; total_tts_characters: number; request_count: number;
  debited_micros: number; debited_voice_credits: string;
  period_debit_percentage: number; monthly_limit_percentage: number;
  utilization_percentage?: number; utilization_basis?: 'monthly_hard_limit' | 'available_plus_period_debit';
}
export type TokenEstimate = {
  tier: SwicoTier; tier_label: string; pricing_as_of: string;
  estimated_blended_tokens: number | null;
  blended_assumption?: string; range_min_tokens: number; range_max_tokens: number;
  explanation: string;
}
export type TopupTokenEstimate = {
  tier: SwicoTier; tier_label: string; estimated_blended_tokens: number | null;
  range_min_tokens: number; range_max_tokens: number;
}
export type TopupEstimateResponse = {
  gross_amount_paise: number; credit_bucket?: CreditBucket;
  token_estimate: TopupTokenEstimate | null; voice_estimate?: VoiceCreditEstimate | null;
}
export type UsageSummary = {
  period: 'current_month' | '30d' | 'all'; timezone: string;
  tier: SwicoTier; tier_label: string;
  period_start: string; period_end: string; next_reset_at: string | null;
  request_count: number; input_tokens: number; cached_input_tokens: number;
  output_tokens: number; total_tokens: number; actual_usage_count: number;
  estimated_usage_count: number; debited_micros: number; debited_ai_credits: string;
  available_micros: number; available_ai_credits: string;
  chat_available_micros?: number; chat_available_credits?: string;
  voice_available_micros?: number; voice_available_credits?: string; wallets?: Wallets;
  daily: Array<{ date: string } & UsageBreakdown>;
  estimated_tokens_remaining: TokenEstimate | null;
  monthly_hard_limit_micros: number | null;
  by_tier: Record<SwicoTier, TierUsageBreakdown>;
  voice: VoiceUsageBreakdown;
  billing_exempt?: boolean; balance_display?: 'Unlimited';
}
export type TranscriptionResponse = {
  transcript: string; detected_language: string; duration_seconds: number;
  duration_milliseconds: number; voice_turn_id: string;
  stt_charge: { charged_micros: number; voice_credits: string }; wallet: Wallet; wallets?: Wallets;
}
export type SynthesisResponse = {
  audio_base64: string; mime_type: string; speaker: string;
  target_language_code: 'en-IN' | 'ta-IN'; model: string; character_count: number;
  charged_micros: number; voice_credits: string; wallet: Wallet; wallets?: Wallets;
}
export type VoiceReplyStatus = 'generating' | 'ready' | 'playing' | 'paused' | 'ended' | 'error'
export type VoiceReplyState = {
  status: VoiceReplyStatus; error: string | null; insufficientCredits: boolean; canRetry?: boolean;
}
export type PaymentHistory = {
  credit_bucket?: CreditBucket;
  id: string; gross_amount_paise: number; credited_amount_micros: number;
  platform_share_paise: number; refunded_amount_paise: number;
  credit_reversal_micros: number; status: string; created_at: string;
  updated_at: string; paid_at: string | null; refunded_at: string | null;
  payment_received: boolean; credit_applied: boolean;
  token_estimate?: TokenEstimate; reversal_token_estimate?: TokenEstimate;
  voice_estimate?: VoiceCreditEstimate;
}
