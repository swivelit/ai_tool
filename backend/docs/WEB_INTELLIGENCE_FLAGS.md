# Web intelligence feature flags

All behaviors in this rollout are independently reversible. Boolean flags use
the existing environment parsing convention (`1`, `true`, `yes`, or `on`).

| Flag | Default | Behavior when enabled |
|---|---:|---|
| `GLOBAL_QA_SEMANTIC_ENABLED` | `false` | Tries scoped semantic matches after every exact-cache layer misses. A hit uses zero chat-generation calls; its query embedding can still have provider cost. |
| `GLOBAL_QA_MIN_SIMILARITY` | `0.90` | Minimum existing question-similarity gate for semantic cache candidates. |
| `GLOBAL_QA_EMBEDDING_BACKFILL_BATCH_SIZE` | `50` | Bounded cursor page for the idempotent approved-global-row embedding/vector backfill job. |
| `GLOBAL_QA_CONFIDENCE_FLOOR` | `0.35` | Tombstone floor for idempotent downvote, edit, and regeneration correction. |
| `GLOBAL_QA_CONFIDENCE_MAX` | `1.0` | Maximum confidence after an idempotent upvote correction. |
| `WEB_MEMORY_FACT_RANKING_ENABLED` | `false` | Ranks owner-scoped saved facts and injects only the best one or two above the configured threshold. |
| `WEB_MEMORY_FACT_MIN_SIMILARITY` | `0.35` | Minimum cosine similarity for an embedding-ranked memory fact. |
| `WEB_DETERMINISTIC_TOOLS_ENABLED` | `false` | Enables model-free time/date, arithmetic, unit conversion, JSON, profile/settings, and approved brand/pricing responses on web. |
| `WEB_MODEL_LADDER_DOWNGRADE_ENABLED` | `false` | Maps answer class to an economical initial tier and permits one confidence/truncation escalation. |
| `WEB_DETAILED_MIN_TIER` | `standard` | Minimum initial tier for detailed and long-form turns while the optional ladder is enabled. |
| `WEB_POST_TURN_DISTILLATION_ENABLED` | `false` | Enqueues heuristic-only durable-fact extraction after a completed assistant turn. |
| `WEB_PROMPT_PREFIX_STABLE_ENABLED` | `false` | Keeps the first system message byte-stable for the same client route and provider; dynamic instructions move to a later system message. |
| `WEB_MAX_PROMPT_TOKENS` | `6000` | Absolute serialized provider-request token limit; values below one are clamped to one and cannot disable the guard. |
| `WEB_CONTEXT_RELEVANCE_RANKING_ENABLED` | `false` | Keeps the latest two turns and relevance-ranks older eligible history within existing limits. |
| `WEB_CONTEXT_CANDIDATE_TURNS` | `80` | Bounded active-thread candidate window for PostgreSQL full-text ranking and its deterministic local fallback. |
| `WEB_ANSWER_FEEDBACK_ENABLED` | `false` | Exposes authenticated answer feedback and applies cache confidence correction. |
| `WEB_CONTENT_SEARCH_ENABLED` | `false` | Exposes authenticated full-text search over messages, summaries, and saved facts. |
| `WEB_RESPONSE_PROVENANCE_ENABLED` | `false` | Returns bounded provenance labels in message responses and final SSE payloads. |

`WEB_CROSS_THREAD_MEMORY_ENABLED` remains the controlling existing flag for
cross-chat memory. `WEB_MEMORY_MAX_ITEMS=2` is the rollout cap; supported values
are one or two and larger legacy values are clamped. When memory is injected,
its measured token count replaces
the same amount of history allocation. `WEB_DETERMINISTIC_TOOLS_ENABLED` is
shared by deterministic answers and existing backend-tool web adapters.

All flags belong directly on the existing `ai_tool` Render service. Do not put
them in the shared environment group, static site, PostgreSQL, Valkey, or
billing cron services, and never mirror backend settings through `VITE_*`.
