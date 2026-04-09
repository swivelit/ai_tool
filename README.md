# AI Tool

## Architecture

The primary runtime is now **phone-local agents** in the Expo app.

- `mobile/lib/localAgents.ts` is the main agent runtime.
- `mobile/lib/api.ts` keeps the existing `/api/chat` contract stable and intercepts it locally by default.
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

## Backend Role

The backend still supports:

- existing API screens and sync behavior
- OpenAI fallback when a phone-local agent explicitly cannot answer
- backend RAG/training consumers that now read shared seed files from `mobile/data`

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
  Kept as an old backend-side prototype/reference. Marked deprecated.
- `backend/data/`
  Still used for backend runtime state. It is no longer the checked-in source of truth for agent seeds.

## Notes

- Do not add live phone data to git. The app stores that under Expo document storage, outside the repo.
- Do not treat backend OpenAI-first paths as the main architecture anymore.
- Keep `/api/chat` stable. Mobile continues to intercept it locally first.
