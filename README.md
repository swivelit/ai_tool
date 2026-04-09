# AI Tool

## Architecture

The primary runtime is now **phone-local agents** in the Expo app.

- `mobile/lib/localAgents.ts` is the main agent runtime.
- `mobile/lib/api.ts` keeps the existing `/api/chat` contract stable and intercepts it locally by default.
- The Orchestrator Agent is now the local-first traffic cop.
  It routes greeting/small-talk, clarification, profile, reminders/tasks, weather/live-tool requests, offline reasoning, and only then considers backend fallback.
- The Alignment Agent now rewrites local or fallback drafts to the user's preferred tone/language while preserving facts.
- The Memory & Cache Agent is now the final local-first intelligence layer.
  It owns semantic cache lookup, durable memory consolidation, conservative profile updates, and memory chunk persistence on-device.
- `mobile/data/` is the checked-in source of truth for agent configs, prompts, training seeds, and RAG seeds.
- On first launch, the app bootstraps those checked-in seed files into `Expo FileSystem.documentDirectory/data`.
- Live phone runtime data stays only in `documentDirectory/data` and is not stored in git.
- The backend is now a **mirror / support / OpenAI fallback** path, not the primary architecture.

## Folder Map

```text
ai_tool/
├── mobile/
│   ├── app/
│   ├── data/
│   │   ├── config/
│   │   │   ├── agent_registry.json
│   │   │   ├── alignment_rules.json
│   │   │   ├── memory_rules.json
│   │   │   ├── models.json
│   │   │   ├── orchestrator_routes.json
│   │   │   ├── profiler_slots.json
│   │   │   ├── prompts.json
│   │   │   └── workspace_manifest.json
│   │   ├── rag/
│   │   │   └── seed/
│   │   │       ├── fast_rag_replies.csv
│   │   │       ├── local_rag_keywords.csv
│   │   │       └── local_rag_synonyms.csv
│   │   └── training/
│   │       └── seed/
│   │           ├── alignment.jsonl
│   │           ├── classifier_dataset.csv
│   │           ├── memory.jsonl
│   │           ├── orchestrator.jsonl
│   │           ├── pipeline_questions.csv
│   │           ├── profiler.jsonl
│   │           └── rag.jsonl
│   └── lib/
│       ├── api.ts
│       ├── localAgentBootstrap.ts
│       ├── localAgentSeedManifest.ts
│       └── localAgents.ts
├── backend/
│   ├── app/
│   ├── config.py
│   └── data/
│       └── ... runtime-only backend state/db/logs ...
└── README.md
```

## Phone Bootstrap Flow

1. The checked-in seed files live under `mobile/data/`.
2. `mobile/lib/localAgentBootstrap.ts` copies those files into `documentDirectory/data` on first launch, or when the checked-in seed version changes.
3. `mobile/lib/localAgents.ts` reads runtime config from `documentDirectory/data`.
4. Runtime folders such as profiles, cache, memory, conversations, tasks, `rag/runtime`, and `training/captures` are created on-device only.

## Profiler Runtime Artifacts

The Profiler Agent is local-first and writes its runtime state under `documentDirectory/data` on the phone:

- `profiles/{userId}/answers.json`
  Structured slot values collected during onboarding.
- `profiles/{userId}/summary.json`
  Compact factual profile summary plus confidence and note metadata.
- `profiles/{userId}/profiler_state.json`
  Conversation state, current target slot, missing slots, confidence-by-slot, and profiler notes.
- `conversations/{userId}.jsonl`
  Append-only onboarding chat transcript.
- `rag/runtime/{userId}_profile_rag.json`
  Profile summary bundle with retrieval-ready chunks and metadata.
- `rag/runtime/{userId}_chunks.json`
  Flattened runtime RAG chunks, including the generated profile chunks.
- `training/captures/profiler.jsonl`
  Non-blocking training captures from profiler turns and completions.

Profiler completion happens on-device first. The backend mirror remains secondary and must not be treated as source of truth.

## Orchestrator And Alignment Runtime

The chat path still enters through `/api/chat`, but the main decision tree now runs locally inside `mobile/lib/localAgents.ts`.

Routing order:

1. Semantic cache hit, if available.
2. Fast local rules for greeting/small-talk, reminders, schedule/tasks, weather, profile requests, and obvious ambiguity.
3. Qwen3 local orchestrator decision with explicit typed output:
   `route`, `reason`, `confidence`, `needsClarification`, `clarificationQuestion`, `needsLiveData`, `selectedModel`, `fallbackAllowed`.
4. Local tool or local reasoning execution:
   - `Qwen3 8B` by default
   - `Qwen3 14B` for longer or more multi-step/context-heavy prompts
5. Gemma 3 4B alignment rewrite using local profile summary, answers, preferences, and language settings.
6. Backend/OpenAI fallback only when one of these is true:
   - the local reasoner returns `__OPENAI_FALLBACK__`
   - the orchestrator marks `needsLiveData = true`
   - no safe local tool/model path can answer

Runtime artifacts added for the new agents:

- `training/captures/orchestrator.jsonl`
  Route decisions and training captures for the local orchestrator.
- `training/captures/alignment.jsonl`
  Draft-to-final alignment captures.
- `conversations/{userId}_routes.jsonl`
  Append-only route decision log with route metadata and fallback-policy context.

## Memory And Cache Runtime

The semantic cache is now a single phone-local runtime path inside `mobile/lib/localAgents.ts`.

- Cache lookup uses the configured embedding model, currently `Qwen/Qwen3-Embedding-0.6B`.
- Cache hits are based on semantic similarity, not exact text match.
- Cache reuse happens before orchestrator routing, backend calls, or OpenAI fallback.
- Cached factual content is preserved in English form, and alignment may be reapplied only for style/language presentation.
- Older backend semantic-cache prototypes remain deprecated and are not the primary mobile decision path.

Runtime files:

- `cache/semantic_cache.json`
  Shared semantic cache store with entries plus hit metadata such as source question, matched question, similarity, timestamp, and whether alignment was reapplied.
- `memory/daily_summaries/{userId}.jsonl`
  Append-only consolidation summaries for recent conversation windows.
- `memory/durable_facts/{userId}.json`
  Conservatively filtered durable user facts.
- `memory/profile_updates/{userId}.jsonl`
  Applied or skipped conservative profile update decisions.
- `rag/runtime/{userId}_memory_chunks.json`
  Retrieval-ready memory chunks embedded with the same configured embedding model used by semantic cache and local RAG search.
- `training/captures/memory.jsonl`
  Non-blocking memory/cache training captures.

Idle-safe consolidation is exposed from `mobile/lib/localAgents.ts` through `consolidateLocalMemoryOnIdle(...)`.
It can be called manually or from future background scheduling hooks.
It summarizes recent conversations, extracts durable facts, updates the profile conservatively, refreshes memory chunks, and writes training captures without making OpenAI the default path.

## Backend Role

The backend still supports:

- existing API screens and sync behavior
- OpenAI fallback when a phone-local agent explicitly cannot answer
- backend RAG/training consumers that now read shared seed files from `mobile/data`

Deprecated backend onboarding remains optional for legacy API compatibility only:

- the backend must boot even if deprecated onboarding extras are missing
- legacy onboarding import failures should only disable that deprecated route, not `/health` or `/api/chat`
- after Render deploy, verify boot with the health endpoint at `/health`

Backend runtime state remains under `backend/data/`:

- database files
- generated docs
- logs
- backend agent mirror state

## Running Locally

### Mobile

```bash
cd mobile
npm install
npx expo start
npm run test:local-agents
```

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### Optional local Theni-Tamil API

```bash
cd backend
source .venv/bin/activate
export THENI_MODEL_ROOT=./models/stage_tamil_thenitamil_model
uvicorn theni_tamil_api:app --host 127.0.0.1 --port 9009
```

## Legacy Paths Left In Place

- `backend/app/onboarding_agent.py`
  Kept for legacy backend onboarding API compatibility. Marked deprecated.
- `backend/app/semantic_cache.py`
  Kept as an old backend-side prototype/reference only. Marked deprecated and no longer the primary semantic-cache path.
- `backend/data/`
  Still used for backend runtime state. It is no longer the checked-in source of truth for agent seeds.

## Notes

- Do not add live phone data to git. The app stores that under Expo document storage, outside the repo.
- Do not treat backend OpenAI-first paths as the main architecture anymore.
- Keep `/api/chat` stable. Mobile continues to intercept it locally first.
- If memory or cache config files are missing, tiny in-code fallbacks exist only to keep the local path safe to boot.
