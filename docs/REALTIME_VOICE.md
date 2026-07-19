# Real-time Voice Mode

Voice Mode is an authenticated web feature. The browser connects only to the
Swico API; provider credentials and provider WebSockets remain server-side.
Sarvam supplies streaming STT/TTS, while the selected Swico tier uses the
existing chat service, persisted threads/messages, and deployed Chat/Voice
wallet architecture. This release adds no schema migration, service, database,
Valkey, Cron Job, disk, or stored-audio facility. Alembic head remains
`e2b7c4d9a1f3`.

## Handshake and wallet preflight

The browser first calls authenticated `POST /api/web/voice/sessions`. Before a
one-use ticket is minted, the API performs a non-mutating capacity check for
the initial five-second Voice STT reservation and the minimum non-zero Chat
reserve for the selected tier. A failure is HTTP 402:

```json
{"error":{"code":"insufficient_voice_credit","credit_bucket":"voice","required_micros":41667,"available_micros":0,"message":"Add Voice credits to start Voice Mode."}}
```

The Chat form uses `insufficient_chat_credit` and `credit_bucket: "chat"`.
`SWICO_INTERNAL_TEST_EMAILS` accounts bypass wallet capacity checks, but still
create billing-exempt usage audit rows and remain subject to provider, safety,
rate-limit, and configuration controls. Preflight is not a reservation: the
WebSocket transaction still locks and reserves after connection, so a race is
handled with one targeted error and application close code.

The response contains a short-lived one-use ticket and a WebSocket URL without
the ticket. The browser adds the query value only when constructing the socket.
Only a SHA-256 ticket digest and minimal session metadata are held in the
existing private Valkey. Origin must exactly match `CORS_ALLOW_ORIGINS`; a
per-user compare-and-delete lock allows one session. Retry fully closes the old
socket/media and always calls the ticket endpoint again.

Never log tickets, Firebase tokens, headers, API keys, raw audio, transcript,
assistant text, email, provider response bodies, or payment secrets. Safe Voice
diagnostics contain only stage, exception class, sanitized provider close code
and category, duration, turn number, cleanup result, and reservation-release
result. Allowed stages are `ticket_consumed`, `session_started`,
`stt_reservation`, `sarvam_stt_connect`, `microphone_stream`,
`endpoint_pending`, `chat_prepare`, `chat_generate`, `sarvam_tts_connect`,
`tts_stream`, `settlement`, and `client_disconnect`.

## Protocol version 1

Client JSON messages are `session.start`, `turn.end`, `mute`, `unmute`, `ping`,
and `session.close`. `interrupt` is accepted for backwards compatibility but
does not interrupt an answer: only Sarvam `START_SPEECH` is authoritative.
Microphone frames are four-byte big-endian sequence plus bounded 16 kHz mono
PCM s16le. Duplicate/out-of-order sequences are ignored.

Server state is explicit: `connecting`, `listening`, `endpoint_pending`,
`thinking`, `speaking`, `interrupted`, `closing`, `error`, `closed`.
`state.changed` exposes it; `endpoint_pending` renders “Still listening…”.
Representative messages:

```json
{"protocol_version":1,"type":"session.ready","state":"connected","audio_mime_type":"audio/mpeg","preroll_ms":320,"barge_in_min_ms":180}
{"protocol_version":1,"type":"state.changed","state":"endpoint_pending","turn_number":1}
{"protocol_version":1,"type":"stt.partial","transcript":"...","turn_number":1}
{"protocol_version":1,"type":"stt.final","transcript":"...","turn_number":1}
{"protocol_version":1,"type":"assistant.start","turn_number":1}
{"protocol_version":1,"type":"assistant.delta","delta":"...","turn_number":1}
{"protocol_version":1,"type":"audio.start","content_type":"audio/mpeg"}
{"protocol_version":1,"type":"audio.end","characters":42,"interrupted":false}
{"protocol_version":1,"type":"turn.done","thread_id":"...","user_message_id":"...","assistant_message_id":"...","turn_number":1,"input_mode":"realtime_voice","completion_status":"complete"}
```

`turn.done` is emitted only after both ordinary chat messages are complete and
the chat reservation is settled. The web app activates a new Voice-created
thread, reloads authoritative messages by public ID, refreshes the thread list
and wallets, and repeats that authoritative refresh on close. Failed/cancelled
turns are not presented as complete; completed turns are never deleted by End
conversation and survive browser refresh.

## Endpointing, gating, barge-in, and accounting

The browser keeps a 320 ms PCM ring but forwards nothing until RMS indicates
sustained speech for 180 ms. It then sends bounded pre-roll, speech, and at most
1.8 seconds of trailing silence so Sarvam VAD can close the segment. RMS is
only a speech gate and visual cue; it never stops assistant playback. Sarvam
`START_SPEECH` cancels a pending endpoint, confirms barge-in, stops playback,
cancels remaining TTS and cooperatively cancels generation. A single spike or
assistant echo therefore cannot repeatedly interrupt.

The server has one persistent STT reader. It normalizes official
`type=events`/`signal_type=START_SPEECH|END_SPEECH`, compatible direct speech
events, partials, finals, errors, and provider closes. Final transcript segments
are accumulated. END_SPEECH/final starts a 900 ms timer; speech restart cancels
it without dropping accumulated text. Bounded English/Tamil continuation
heuristics add 650 ms for conjunctions, fillers, trailing comma/dash, and
incomplete clauses. Terminal punctuation avoids grace. The delay never exceeds
1,800 ms, an utterance never exceeds 30 seconds, and explicit `turn.end`
flushes/finalizes safely. This is VAD, duration, and text-completeness logic; it
does not claim emotion or tone understanding.

Every provider PCM byte is forwarded only while an STT reservation or explicit
billing-exempt audit row is active. Reservation expansion commits before audio
forwarding. After endpointing, consumed gated audio is settled once and the
next turn is reserved before thinking/speaking so provider-confirmed barge-in
cannot become unreserved audio. Silence suppressed by the browser is neither
sent nor billed. TTS reserves before sending text, expands idempotently, settles
submitted characters, and releases unused remainder. Disconnect/interruption
cancels and awaits tasks, releases every live reservation, closes providers,
and compare-deletes the Valkey lock.

Sarvam wire behavior follows the official [streaming STT guide](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/streaming-api), [STT WebSocket reference](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/ws), and [TTS WebSocket reference](https://docs.sarvam.ai/api-reference/text-to-speech/stream). The current endpoints are `/speech-to-text/ws` and `/text-to-speech/ws`; both use `Api-Subscription-Key`. TTS sends config first, then text and flush, decodes progressive MP3, and stops on final completion event.

## Stable errors and close codes

| Code | Close | Meaning |
| --- | ---: | --- |
| `voice_protocol_mismatch` | 4400 | unsupported client protocol |
| `voice_session_expired` | 4401 | invalid, expired, or consumed ticket |
| `voice_origin_rejected` | 4403 | Origin rejected |
| `voice_session_active` | 4409 | existing active user session |
| `voice_rate_limit` | 4429 | Voice start/turn rate limit |
| `insufficient_chat_credit` | 4450 | Chat reserve unavailable |
| `insufficient_voice_credit` | 4451 | Voice reserve unavailable |
| `sarvam_authentication_failed` | 4460 | provider authentication rejection |
| `sarvam_quota_exhausted` | 4461 | provider quota/rate rejection |
| `sarvam_temporarily_unavailable` | 4462 | transient provider outage |
| `sarvam_protocol_error` | 4463 | incompatible provider message/close |
| `voice_idle_timeout` | 4470 | idle limit |
| `voice_maximum_duration` | 4471 | session duration limit |
| `voice_network_interrupted` | 4472 | abnormal network loss (client mapping) |
| `voice_internal_failure` | 4500 | contained internal failure |

HTTP also uses structured `voice_session_active`, `voice_rate_limit`, and
credit errors. `microphone_permission_denied` is a browser-local structured
error. The first structured error always wins over a later socket close.

## Environment

```dotenv
WEB_REALTIME_VOICE_ENABLED=false
WEB_SEPARATE_VOICE_CREDITS_ENABLED=false
WEB_REALTIME_VOICE_SESSION_TICKET_TTL_SECONDS=60
WEB_REALTIME_VOICE_MAX_SESSION_SECONDS=900
WEB_REALTIME_VOICE_IDLE_TIMEOUT_SECONDS=60
WEB_REALTIME_VOICE_MAX_CONCURRENT_SESSIONS_PER_USER=1
WEB_REALTIME_VOICE_START_RATE_LIMIT_PER_MINUTE=5
WEB_REALTIME_VOICE_END_SILENCE_MS=900
WEB_REALTIME_VOICE_UNFINISHED_GRACE_MS=650
WEB_REALTIME_VOICE_MAX_ENDPOINT_WAIT_MS=1800
WEB_REALTIME_VOICE_MIN_SPEECH_MS=250
WEB_REALTIME_VOICE_MAX_UTTERANCE_MS=30000
WEB_REALTIME_VOICE_BARGE_IN_MIN_MS=180
WEB_REALTIME_VOICE_PREROLL_MS=320
```

## Manual production verification and rollback

Use a dedicated backend-only `SWICO_INTERNAL_TEST_EMAILS` account. In browser
DevTools confirm one ticket POST, one `wss:` connection, connected → listening,
no ticket reuse, and no credential/provider payload in logs. Test English and
Tamil with a 300 ms pause followed by continuation, a completed 900 ms pause,
an unfinished clause receiving grace, second automatic listening turn, and
provider-confirmed barge-in. Complete a turn, close Voice Mode, confirm both
text messages appear in ordinary chat, then refresh the browser and confirm
they persist. Test 320 px portrait and mobile landscape with keyboard focus,
Escape, reduced motion, and microphone denial.

Immediate feature disable: set `WEB_REALTIME_VOICE_ENABLED=false` on the
existing API service and deploy the API configuration. Bootstrap removes the
entry point; existing ordinary chat/history and wallet data remain intact.
Fix forward—do not roll back the database. Checkout remains disabled pending
legal publication and payment verification.
