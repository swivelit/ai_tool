# Web intelligence feature flags

All behaviors in this rollout are independently reversible. Boolean flags use
the existing environment parsing convention (`1`, `true`, `yes`, or `on`).

| Flag | Default | Behavior when enabled |
|---|---:|---|
| `GLOBAL_QA_SEMANTIC_ENABLED` | `false` | Writes real question embeddings to the `global_qa` vector namespace and tries scoped top-5 semantic matches after an exact cache miss. |
| `GLOBAL_QA_MIN_SIMILARITY` | `0.90` | Minimum existing question-similarity gate for semantic cache candidates. |
| `WEB_MEMORY_FACT_RANKING_ENABLED` | `false` | Ranks saved facts with cached query embeddings and injects at most three facts above the configured threshold. |
| `WEB_MEMORY_FACT_MIN_SIMILARITY` | `0.35` | Minimum cosine similarity for an embedding-ranked memory fact. |
| `WEB_DETERMINISTIC_TOOLS_ENABLED` | `false` | Enables model-free time/date, arithmetic, unit conversion, JSON, profile/settings, and approved brand/pricing responses on web. |
| `WEB_MODEL_LADDER_DOWNGRADE_ENABLED` | `false` | Maps answer class to an economical initial tier and permits one confidence/truncation escalation. |
| `WEB_POST_TURN_DISTILLATION_ENABLED` | `false` | Enqueues heuristic-only durable-fact extraction after a completed assistant turn. |
| `WEB_PROMPT_PREFIX_STABLE_ENABLED` | `false` | Keeps the first system message byte-stable for the same client route and provider; dynamic instructions move to a later system message. |
| `WEB_MAX_PROMPT_TOKENS` | `6000` | Hard prompt budget. Set to `0` to disable allocation and hard trimming. |
| `WEB_CONTEXT_RELEVANCE_RANKING_ENABLED` | `false` | Keeps the latest two turns and relevance-ranks older eligible history within existing limits. |
| `WEB_ANSWER_FEEDBACK_ENABLED` | `false` | Exposes authenticated answer feedback and applies cache confidence correction. |
| `WEB_CONTENT_SEARCH_ENABLED` | `false` | Exposes authenticated full-text search over messages, summaries, and saved facts. |
| `WEB_RESPONSE_PROVENANCE_ENABLED` | `false` | Returns bounded provenance labels in message responses and final SSE payloads. |

`WEB_CROSS_THREAD_MEMORY_ENABLED` remains the controlling existing flag for
cross-chat memory. When memory is injected, its measured token count replaces
the same amount of history allocation. `WEB_DETERMINISTIC_TOOLS_ENABLED` is
shared by deterministic answers and existing backend-tool web adapters.
