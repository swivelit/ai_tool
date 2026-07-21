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

Website messages, revisions, user-scoped memory, reservations, settled usage,
and wallet ledger records live in PostgreSQL. Temporary extracted attachment
text lives in the dedicated private Valkey and raw uploads are not retained.

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
