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

## Success Metrics

The Golden Assistant evaluation system measures assistant intelligence, reliability, performance, and user experience using the following success metrics.

### Answer Quality
Measures correctness, relevance, and helpfulness of assistant responses.

Targets:
- >= 90% golden eval accuracy
- >= 4/5 average user satisfaction

Evaluation signals:
- Expected route/tool matches
- Correct safety behavior
- Correct language handling
- Deterministic output validation

### Latency
Measures assistant response speed from request start to final response.

Targets:
- First token latency < 1.5s
- Full response latency < 4s

Evaluation signals:
- Local routing speed
- Tool execution duration
- Backend response completion time

### Local-First Rate
Measures how often requests are successfully handled using local models, local memory, local RAG, or local cache before cloud fallback.

Targets:
- >= 70% local-first handling

Evaluation signals:
- Local routing success
- Semantic cache hits
- Offline-capable execution

### Clarification Rate
Measures how often the assistant asks follow-up clarification questions because the user intent is ambiguous.

Targets:
- 10%–20%

Evaluation signals:
- Ambiguous prompt detection
- Clarification necessity validation
- Reduced unnecessary clarification prompts

### Fallback Rate
Measures how often the assistant fails and falls back to generic or safe responses.

Targets:
- < 5%

Evaluation signals:
- Unknown intent handling
- Failed routing cases
- Tool/model fallback frequency

### Crash-Free Sessions
Measures application stability during assistant interactions.

Targets:
- >= 99.5% crash-free sessions

Evaluation signals:
- Successful eval execution
- No runtime crashes
- Stable routing and tool execution

## Goal

The primary goal of the golden evaluation system is to define what “smarter assistant behavior” means and continuously verify improvements without introducing regressions in routing, safety, latency, reliability, or user experience.
