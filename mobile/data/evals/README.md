# Golden Assistant Evals

This folder contains deterministic golden cases for assistant routing and intelligence regressions.

## Dataset

`golden_assistant.json` is the shared dataset. Each case has:

- `id`: stable case id. Keep it unique and descriptive.
- `surface`: runner target, for example `mobile_local_agent`, `mobile_voice`, `backend_emergency`, `backend_health`, or `backend_agentic`.
- `prompt`: user prompt under evaluation.
- `fixtures`: local deterministic state such as profile answers, reminders, RAG chunks, or semantic cache entries.
- `mocks`: deterministic model/tool responses. Do not depend on real OpenAI, backend, native models, or network calls.
- `expected`: route, tool, language, safety, cache, source, or consent expectations.

Keep the dataset between 50 and 100 cases so it stays fast enough for CI while covering the important regressions.

## Run

From `mobile/`:

```sh
npm run eval:golden
```

This runs:

- `test/goldenAssistant.eval.test.ts` for phone-local assistant routing, tools, language, RAG, memory, semantic cache, and cloud consent.
- `test/goldenVoice.eval.test.ts` for local voice/STT unavailable behavior.

From `backend/`:

```sh
python -m pytest tests/test_golden_eval.py -s
```

This runs the backend subset for emergency routing, health-sensitive handling, and agentic onboarding profile safety.

From the repository root, CI can run both with:

```sh
./scripts/run_golden_eval.sh
```

## Adding Cases

Add a case to `golden_assistant.json`, then choose the right `surface`.

- Use `mobile_local_agent` for local chat routing, tools, RAG, cache, memory, language, or cloud-consent behavior.
- Use `mobile_voice` for voice/STT API behavior.
- Use `backend_emergency` for emergency classifier prompts.
- Use `backend_health` for medical-disclaimer/risk handling.
- Use `backend_agentic` for backend agentic orchestration regressions.

Prefer small deterministic fixtures. If a model response is needed, put it in `mocks` so the eval never calls real cloud, native model, or live services.
