# Backend AI Architecture

## Workflow

```mermaid
flowchart TD
  Mobile[Mobile chat or voice] --> Auth[FastAPI auth and ownership checks]
  Auth --> Budget[Quota and provider budget guard]
  Budget --> Intent[Rules-first safety, language and intent routing]
  Intent --> Block[Blocked/clarify: live data and unsafe high-risk]
  Intent --> Tool[Backend tools: reminders, routine, profile, settings]
  Intent --> Cache[Approved global cache and local RAG for safe normal turns]
  Intent --> Sarvam[Sarvam AI: Indic chat, STT, TTS, translation]
  Intent --> OpenAINano[OpenAI gpt-5-nano: cheap English/general]
  Intent --> OpenAIMini[OpenAI gpt-5-mini: coding/complex fallback]
  Sarvam --> Fallback[One controlled fallback on provider error only]
  OpenAINano --> Fallback
  OpenAIMini --> Fallback
  Tool --> Usage[ai_usage_events]
  Sarvam --> Usage
  OpenAINano --> Usage
  OpenAIMini --> Usage
  Block --> Usage
  Usage --> Contract[Existing response: ok, item, assistant, pipeline, meta]
```

## Agents

- `AIProviderRouter`: deterministic route selection from language and intent.
- `SarvamProvider`: Sarvam chat, STT, and TTS with redacted provider errors.
- `OpenAIProvider`: tracked Chat Completions using `OpenAIModelRouter`.
- `run_text_turn`: single-provider orchestrator with safety-before-cache,
  backend tools, and one controlled fallback only after provider errors.
- `tools`: rules-only backend actions for reminders, profile, routine, and settings.
- `response_adapter`: maps provider output into the existing pipeline shape.

## Routing Table

| Request type | Provider/model |
| --- | --- |
| Tamil/Indic script or Tanglish/Hinglish | Sarvam `sarvam-30b` |
| Complex Indic reasoning | Sarvam `sarvam-105b` |
| English general chat | OpenAI `gpt-5-nano` |
| Coding, architecture, debugging | OpenAI `gpt-5-mini` |
| Reminder/routine/profile/settings | Backend tool, no model call |
| STT/TTS | Sarvam `saaras:v3`, `bulbul:v2` default |
| Latest/current/live data for free users | Blocked with clear unavailable message |

Voice uploads use Sarvam Saaras for STT first. The transcript then routes like a
normal text turn: English transcripts go to OpenAI, Indic/Tanglish transcripts go
to Sarvam chat, and backend-tool intents use backend tools.

## Env Vars

Core flags: `AI_ROUTER_ENABLED`, `AI_LEGACY_PIPELINE_ENABLED`,
`AI_PROVIDER_ROUTING_MODE`, `AI_MAX_PROVIDER_CALLS_PER_TURN`,
`FREE_DAILY_TEXT_LIMIT`, `FREE_DAILY_VOICE_SECONDS`,
`ENABLE_WEB_SEARCH_FOR_FREE`, `ENABLE_OPENAI_FILE_SEARCH`,
`ENABLE_OPENAI_MODERATION`, `AI_ALLOW_OPENAI_TO_SARVAM_FALLBACK`,
`AI_ALLOW_SARVAM_COMPLEX_FALLBACK`.

OpenAI defaults: `OPENAI_MODEL`, `OPENAI_JSON_MODEL`,
`OPENAI_MODEL_CHEAP`, `OPENAI_MODEL_STANDARD`, `OPENAI_MODEL_REASONING`,
`OPENAI_MODEL_HIGH`, `OPENAI_DISABLE_HIGHEST_MODEL`,
`OPENAI_MAX_OUTPUT_TOKENS_DEFAULT`, `OPENAI_MAX_OUTPUT_TOKENS_HARD`,
`OPENAI_DAILY_BUDGET_USD`, `OPENAI_EMBEDDING_MODEL`.

Sarvam defaults: `SARVAM_CHAT_MODEL`, `SARVAM_CHAT_MODEL_REASONING`,
`SARVAM_STT_MODEL`, `SARVAM_STT_MODE`, `SARVAM_TTS_MODEL`,
`SARVAM_TTS_MODEL_PREMIUM`, `SARVAM_TTS_SPEAKER`,
`SARVAM_DAILY_BUDGET_INR`.

## Cost Controls

- Free non-admin users are limited by `ai_usage_events` daily text and voice totals.
- Provider budgets stop new provider calls with HTTP 503 when configured spend is exhausted.
- OpenAI flagship/high models stay disabled unless explicitly enabled and allowlisted.
- Text turns use at most one provider call by default. Cache/tool/block routes call no model.
- Provider fallback is limited by `AI_MAX_PROVIDER_CALLS_PER_TURN_HARD`; it never
  runs for safety blocks, disabled live data, quota, or budget failures.
- Voice quota is enforced before STT from estimated audio duration and logged in
  `ai_usage_events.audio_seconds`.
- Usage is recorded for provider, cache, tool, STT, TTS, and blocked routes.

## Deployment Checklist

- Run Alembic migration `e7a2c9d5b8f4_add_ai_usage_events`.
- Set `SARVAM_API_KEY` and `OPENAI_API_KEY` in Render or the target backend.
- Keep all public mobile env vars key-free; only backend stores provider secrets.
- Verify `AI_ROUTER_ENABLED=true` and `AI_LEGACY_PIPELINE_ENABLED=false`.
- Keep `LOG_CHAT_CONTENT=false` in production unless explicitly debugging with
  redacted previews.
- Set mobile release env to backend-first:
  `EXPO_PUBLIC_USE_LOCAL_CHAT_PIPELINE=false`,
  `EXPO_PUBLIC_USE_LOCAL_VOICE_PIPELINE=false`, and
  `EXPO_PUBLIC_ENABLE_LOCAL_MODEL_FALLBACK=false`.
- Run backend pytest, mobile typecheck, and mobile vitest before release.
- Manual smoke: send English chat, Tamil/Tanglish chat, reminder creation, TTS,
  and voice STT through a Firebase-authenticated account.
