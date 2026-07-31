# Current Swico architecture

## Standalone website path

The production website does **not** use `AgentRuntime`.

```text
web/src/pages/ChatPage.tsx
  -> web/src/api/client.ts streamChat()
  -> POST /api/web/chat/stream
  -> backend/app/web_api/router.py
  -> backend/app/web_api/chat_service.py prepare_web_turn()
  -> backend/app/web_api/request_coordinator.py WebRequestCoordinator
  -> execute_web_turn()
  -> AIProviderRouter
  -> OpenAIProvider or SarvamProvider
  -> SSE
```

`WebRequestCoordinator` is deterministic and provider-free. It classifies the
answer size, selects bounded same-thread, cross-thread memory, profile, and
document sources, freezes one exact provider prompt, and supplies safe token
source telemetry. Normal provider-backed turns permit one paid generation
attempt. A configured fallback is safe only after zero output and zero reported
usage.

Same-thread continuity is decided before global cache lookup by
`conversation_continuity.py`, with no model or embedding call. `adaptive` mode
uses explicit resets, explicit/referential and elliptical follow-ups, Unicode
lexical overlap, standalone-subject detection, and a one-turn ambiguous
fallback. It sends at most two complete active non-superseded turns / 900 raw
characters. Cross-thread memory remains a separate owner-scoped source.
Historical messages retain their `user` and `assistant` provider roles, and the
same frozen message list drives prompt estimation, reservation, and provider
invocation.

`backend/app/web_ai/` contains the Phase 0/1 foundation, Phase 2
temporary-document hybrid retrieval, and Phase 3 Answer Guard implementation.
It does not replace
`WebRequestCoordinator`: disabled and shadow modes retain the original path.
The live Phase 2 path is entered only when TRIAG is non-shadow and
`WEB_RAG_HYBRID_ENABLED=true`. It adapts the existing lexical attachment scorer,
optionally caches temporary chunk/query embeddings in the existing private
upload Valkey, fuses and deduplicates candidates, builds a tier-capped evidence
pack, then freezes the exact provider messages. Shadow mode
persists only allowlisted scalar/count metadata in `web_retrieval_trace`; it
does not persist messages, memory/profile text, attachment excerpts, generated
code, secrets, credentials, environment values, or provider/model names.

The safe backend defaults are:

```text
WEB_TRIAG_ENABLED=false
WEB_TRIAG_SHADOW_MODE=true
WEB_TRIAG_POLICY_VERSION=v1
WEB_RAG_HYBRID_ENABLED=false
WEB_RAG_DENSE_ENABLED=false
WEB_RAG_RETRIEVAL_EVALUATOR_ENABLED=false
WEB_ANSWER_GUARD_ENABLED=false
WEB_VERIFIED_STREAMING_ENABLED=false
WEB_ANSWER_GUARD_MODEL_VERIFIER_ENABLED=false
WEB_ANSWER_GUARD_REPAIR_ENABLED=false
```

Phases 2 and 3 remain disabled by default. They add safe `sources` and
`quality` SSE/message metadata. Phase 3 can buffer a draft until deterministic
checks finish and can optionally run one accounted verifier or repair call.
It does not execute repository code or add a validator service, repository
indexing, triplets, hierarchy, or persistent knowledge.

Website messages, revisions, user-scoped memory, reservations, settled usage,
and wallet ledger records live in PostgreSQL. Temporary extracted attachment
text and temporary vectors live in the dedicated private Valkey under the
upload TTL; neither is written to permanent PostgreSQL knowledge tables.

## Legacy/mobile orchestration path

`backend/app/ai/orchestrator.py` uses `AgentRuntime` for another, legacy/mobile
path. Its `MemoryAgent` and `RetrievalAgent` remain prototypes and are not a
production website data source. Website traffic must not be redirected through
that runtime.

## Voice path

Real-time website voice uses the existing WebSocket pipeline in
`backend/app/web_api/router.py`, `SarvamStreamingProvider`, and
`web/src/hooks/useRealtimeVoice.ts`: AudioWorklet PCM frames, streaming STT,
deterministic adaptive endpointing, one finalized transcript per generation,
incremental model deltas, early clause TTS, streamed audio, provider-confirmed
barge-in, and separate billing settlement.
