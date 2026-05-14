# AI Tool

## Architecture

The primary runtime is now **phone-local agents** in the Expo app.

- `mobile/lib/localAgents.ts` is the main agent runtime.
- `mobile/lib/api.ts` keeps the existing `/api/chat` contract stable. Local chat is used only when a reachable local model base URL is configured; otherwise backend chat is used.
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

Profiler completion still writes local artifacts on-device first, but the onboarding completion gate now requires the backend profile refresh to confirm `questionnaireCompleted`. The backend remains secondary for profiler runtime state, but it is the source of truth for allowing the app to continue past onboarding completion.

## Orchestrator And Alignment Runtime

The chat path still enters through `/api/chat`. When `EXPO_PUBLIC_LOCAL_MODEL_BASE_URL` or `extra.LOCAL_MODEL_BASE_URL` is configured to a reachable local model server, the main decision tree runs locally inside `mobile/lib/localAgents.ts`. Without that local model URL, `/api/chat` goes to the backend.

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

Local Android APKs are built from the repo root:

```bash
BUILD_TYPE=debug ./build-apk.sh
./launch-debug_apk.sh
```

The APK build validates native library ABI selection and Android 15+/16 KB page-size compatibility. On a 16 KB emulator, confirm `adb shell getconf PAGE_SIZE` returns `16384`; the build then checks `zipalign -c -P 16 -v 4 dist/tamil-ai-debug.apk` and every `lib/<abi>/*.so` ELF `LOAD` segment alignment before install. See [mobile/README.md](mobile/README.md) for the NDK r27/r28 decision and the debug-only escape hatch.

Profile restore/auth diagnostics for debug APK runs:

```bash
adb logcat -c
adb logcat | grep --line-buffered -E 'ReactNativeJS|\[account\]|\[auth\]|ApiError|users/resolve|Backend profile|Firebase'

curl -i https://ai-tool-rrau.onrender.com/health
curl -i https://ai-tool-rrau.onrender.com/api/health
```

Focused regression tests for auth persistence, boot fail-open behavior, route resolution, and password visibility can also be run with:

```bash
cd mobile
npx vitest run test/firebase.test.ts test/appBoot.test.ts test/authUi.test.ts
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
- Keep `/api/chat` stable. Mobile uses local chat only when a reachable local model base URL is configured; otherwise it uses backend chat.
- If memory or cache config files are missing, tiny in-code fallbacks exist only to keep the local path safe to boot.
- Native Firebase auth now uses AsyncStorage-backed persistence so login survives app restarts on Android/iOS, while web keeps the default web auth behavior.
- App boot uses watchdog-style fail-open handling. Optional local seed bootstrap and profile recovery now warn and continue instead of blocking the boot screen forever.

## Manual QA Checklist

- Fresh install on Android/iOS:
  launch the app with an empty local storage state and confirm the boot screen clears even if local seed bootstrap is slow or unavailable.
- Login persistence on native:
  log in with email/password, fully close the app, reopen it, and confirm the user lands back in the authenticated flow without logging in again.
- Fresh signup flow:
  create a new account, confirm routing goes `signup -> onboarding/profile -> onboarding/questionnaire -> tabs` without a split or half-rendered transition.
- Existing account login flow:
  log in with an already onboarded account and confirm routing goes directly to tabs without flashing onboarding screens.
- Optional seed bootstrap failure:
  simulate or force a local seed bootstrap failure and confirm the app logs a warning and still reaches the app shell.
- Password visibility:
  verify the login password eye toggle works, and both signup password fields independently toggle visibility with accessible labels.
```
# New Developer Setup

## Install Requirements

- Node.js LTS
- npm
- Python 3.11+
- Android Studio
- Git

## Clone Repository

```bash
git clone <repo-url>
cd ai_tool
```

## Mobile Setup

```bash
cd mobile
npm install
npx expo start
```

## Backend Setup

```bash
cd backend

python -m venv venv

# Windows
venv\Scripts\activate

pip install -r requirements.txt
```

## Debug APK

```bash
./launch-debug_apk.sh
```

## Release APK

```bash
BUILD_TYPE=release ./build-apk.sh
```