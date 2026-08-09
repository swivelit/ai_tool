export type SwicoTier = "free" | "lite" | "standard" | "pro";
export type InputMode = "text" | "voice" | "dictation" | "realtime_voice";
export type CreditBucket = "chat" | "voice";

export type Wallet = {
  credit_bucket?: CreditBucket;
  balance_micros: number;
  reserved_micros: number;
  available_micros: number;
  version: number;
  token_estimate?: TokenEstimate | null;
  billing_exempt?: boolean;
  balance_display?: "Unlimited";
};
export type Wallets = { chat: Wallet; voice: Wallet };
export type TokenEstimate = {
  tier: SwicoTier;
  tier_label: string;
  pricing_as_of: string;
  estimated_blended_tokens: number | null;
  blended_assumption?: string;
  range_min_tokens: number;
  range_max_tokens: number;
  explanation: string;
};
export type TierOption = {
  id: SwicoTier;
  label: string;
  description: string;
  available: boolean;
  selected: boolean;
};
export type AssistantSettings = {
  tier: SwicoTier;
  tier_label: string;
  tier_description: string;
  tier_selection_enabled: boolean;
  tiers: TierOption[];
};
export type FeatureFlags = {
  web_chat: boolean;
  prepaid_billing: boolean;
  web_attachments: boolean;
  web_image_uploads?: boolean;
  web_voice_recording: boolean;
  web_voice_reply: boolean;
  web_voice_billing: boolean;
  web_realtime_voice: boolean;
  separate_voice_credits: boolean;
  web_message_edit?: boolean;
  web_cross_thread_memory?: boolean;
  web_long_input?: boolean;
  web_answer_feedback?: boolean;
  web_content_search?: boolean;
  web_response_provenance?: boolean;
  web_repository_upload?: boolean;
  web_repository_chat?: boolean;
  web_repository_validation?: boolean;
  web_knowledge_library?: boolean;
};
export type Bootstrap = {
  user: { id: number; name: string; email: string | null; reply_language: string };
  wallet: Wallet;
  wallets?: Wallets;
  billing: BillingConfig;
  assistant: AssistantSettings;
  features: FeatureFlags;
  backend_release?: string;
  voice_protocol_version?: number;
  voice_tuning?: Record<string, number>;
  uploads: {
    available: boolean;
    ttl_seconds: number;
    max_file_bytes: number;
    max_files_per_message: number;
    max_total_bytes: number;
    supported_extensions: string[];
    long_input_enabled?: boolean;
    long_input_inline_threshold_chars?: number;
    long_input_max_chars?: number;
    image_uploads_enabled?: boolean;
    image_max_file_bytes?: number;
    image_max_count?: number;
  };
  repositories?: {
    ttl_seconds: number;
    max_archive_bytes: number;
    validation_capability: "static_only" | "executable";
  };
};
export type Thread = {
  id: string;
  title: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};
export type Attachment = {
  id: string;
  name: string;
  media_type: string;
  size_bytes: number;
  created_at: string;
  expires_at: string;
  warnings: string[];
  warning_codes?: string[];
  status: "ready" | "expired" | "unavailable";
  /** Local-only preview URI; never sent to or persisted by the backend. */
  local_uri?: string;
};
export type Message = {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  request_id: string | null;
  tier: SwicoTier | null;
  tier_label: string;
  input_tokens: number;
  output_tokens: number;
  usage_source: "actual" | "estimated" | null;
  charge_micros: number;
  status: string;
  created_at: string;
  attachments?: Attachment[];
  input_mode: InputMode;
  voice_turn_id: string | null;
  reply_language: "en" | "ta" | null;
  finish_reason?: string;
  truncated?: boolean;
  can_continue?: boolean;
  completion_status?: string;
  is_continuation_control?: boolean;
  continuation_render_prefix?: string;
  continuation_parent_message_id?: string | null;
  continuation_root_message_id?: string | null;
  continuation_segment_index?: number;
  continuation_rewind_characters?: number;
  replaces_message_id?: string | null;
  revision_number?: number;
  failure_code?: string | null;
  retry_at?: string | null;
  feedback_rating?: "up" | "down" | null;
  provenance?: ("memory" | "document" | "repository" | "cached_answer" | "semantic_cache" | "backend_tool" | "web_search")[];
  sources?: SourceSummary[];
  quality?: ResponseQuality | null;
};
export type SourceSummary = {
  id: string;
  label: string;
  locator: string;
  confidence: number;
  source_kind: string;
};
export type ResponseQuality = {
  status: string;
  retrieval_status: string | null;
  repository_validation_mode: string | null;
  checks: Array<{ type: string; status: string }>;
};
export type SearchResult = {
  thread_id: string | null;
  message_id: string | null;
  snippet: string;
  source_kind: string;
  updated_at: string;
  rank: number;
};
export type ProfileSettings = {
  name: string;
  place: string | null;
  timezone: string;
  assistant_name: string;
  reply_language: "en" | "ta";
  email: string | null;
  email_editable: false;
};
export type MemoryFact = { id: string; value_text: string; category: string; created_at: string; updated_at: string };
export type MemorySettings = { available: boolean; enabled: boolean; items: MemoryFact[] };
export type UsageSummary = {
  request_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  debited_micros: number;
  debited_ai_credits: string;
  by_tier: Record<SwicoTier, { label: string; request_count: number; debited_micros: number; debited_ai_credits: string }>;
  voice: Record<string, unknown>;
  [key: string]: unknown;
};
export type UsagePreferences = {
  period: "monthly";
  hard_limit_micros: number | null;
  hard_limit_ai_credits: string | null;
  warning_threshold_percent: number;
  notify_at_threshold: boolean;
  current_usage_micros: number;
  current_usage_ai_credits: string;
  remaining_micros: number | null;
  warning_reached: boolean;
  hard_limit_token_estimate: TokenEstimate | null;
  remaining_token_estimate: TokenEstimate | null;
  next_reset_at: string;
  timezone: string;
  updated_at: string | null;
  tier: SwicoTier;
  tier_label: string;
  billing_exempt?: boolean;
};
export type RepositorySnapshot = {
  id: string;
  display_name: string;
  source_version: string;
  content_hash: string;
  file_count: number;
  symbol_count: number;
  status: string;
  created_at: string;
  expires_at: string;
  languages: string[];
  frameworks: string[];
};
export type KnowledgeDocument = {
  id: string;
  title: string;
  status: string;
  source_kind: string;
  chunk_count: number;
  approved_at: string;
  created_at: string;
  updated_at: string;
};
export type KnowledgeJobSummary = {
  id?: string;
  status: string;
  progress?: number;
  error_code?: string | null;
  created_at?: string;
  updated_at?: string;
};
export type RealtimeVoiceSession = {
  session_id: string;
  ticket: string;
  websocket_url: string;
  tier: SwicoTier;
  tier_label: string;
  language: "en" | "ta";
  wallets: Wallets;
  playback_mode: string;
  selected_codec: string;
  provider_sample_rate: number | null;
  media_source_allowed: boolean;
  approved_websocket_hosts?: string[];
};
export type StreamEvent = { event: string; data: unknown };

export type ChatRequestPayload = {
  request_id: string;
  message: string;
  thread_id?: string;
  attachment_ids?: string[];
  repository_id?: string;
  input_mode: InputMode;
  voice_turn_id?: string;
  continue_message_id?: string;
  edit_message_id?: string;
  regenerate_message_id?: string;
};

export type TranscriptionResponse = {
  transcript: string;
  detected_language: string;
  duration_seconds: number;
  duration_milliseconds: number;
  voice_turn_id: string;
  stt_charge: { charged_micros: number; voice_credits: string };
  wallet: Wallet;
  wallets?: Wallets;
};
export type SynthesisResponse = {
  audio_base64: string;
  mime_type: string;
  speaker: string;
  target_language_code: "en-IN" | "ta-IN";
  character_count: number;
  charged_micros: number;
  voice_credits: string;
  wallet: Wallet;
  wallets?: Wallets;
};

export type VoiceCreditEstimate = {
  pricing_version?: string;
  estimated_stt_seconds?: number;
  estimated_stt_minutes: string;
  estimated_tts_characters: number;
  assumption: string;
};
export type BillingPackage = {
  gross_amount_paise: number;
  credited_amount_micros: number;
  platform_share_paise: number;
  token_estimate?: TokenEstimate;
  voice_estimate?: VoiceCreditEstimate;
};
export type BillingConfig = {
  currency: "INR";
  credit_percent: string;
  razorpay_key_id?: string;
  min_topup_paise: number;
  max_topup_paise: number;
  razorpay_mode: "test" | "live";
  checkout_enabled: boolean;
  custom_topup_enabled: boolean;
  packages: BillingPackage[];
};
export type TopupTokenEstimate = {
  tier: SwicoTier;
  tier_label: string;
  estimated_blended_tokens: number | null;
  range_min_tokens: number;
  range_max_tokens: number;
};
export type TopupEstimateResponse = {
  gross_amount_paise: number;
  credit_bucket?: CreditBucket;
  token_estimate: TopupTokenEstimate | null;
  voice_estimate?: VoiceCreditEstimate | null;
};
export type PaymentHistory = {
  credit_bucket?: CreditBucket;
  id: string;
  gross_amount_paise: number;
  credited_amount_micros: number;
  platform_share_paise: number;
  refunded_amount_paise: number;
  credit_reversal_micros: number;
  status: string;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  refunded_at: string | null;
  payment_received: boolean;
  credit_applied: boolean;
  token_estimate?: TokenEstimate;
  reversal_token_estimate?: TokenEstimate;
  voice_estimate?: VoiceCreditEstimate;
};
