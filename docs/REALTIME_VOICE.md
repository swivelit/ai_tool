# Real-time Voice Mode

Voice Mode is an authenticated web feature. The browser connects only to the
Swico API; provider credentials and provider WebSockets remain server-side.
Sarvam supplies streaming STT/TTS, while the selected Swico tier uses the
existing chat service, persisted threads/messages, and deployed Chat/Voice
wallet architecture. This release adds no schema migration, service, database,
Valkey, Cron Job, disk, or stored-audio facility.

## Local startup, handshake, and wallet preflight

After bootstrap release/protocol/feature compatibility is verified, the browser
requests microphone permission, creates the AudioContext, loads the same-origin
AudioWorklet, connects the source/processor, and completes local calibration.
Only then does it call authenticated `POST /api/web/voice/sessions`, open the
WebSocket, send `session.start`, and wait for `session.ready` with
`state=listening`. Frames are gated until that listening-ready message. A
permission failure therefore creates no ticket or Valkey lock; ticket or socket
failure closes the microphone tracks, worklet, and AudioContext. Before a
one-use ticket is minted, the API performs a non-mutating capacity check for
the initial five-second Voice STT reservation plus the smallest non-zero LLM
reservation for the selected tier. Both requirements are checked only against
the Voice wallet; Chat balance does not control realtime Voice readiness. A
failure is HTTP 402 with the calculated combined `required_micros`:

```json
{"error":{"code":"insufficient_voice_credit","credit_bucket":"voice","required_micros":41667,"available_micros":0,"message":"Add Voice credits to start Voice Mode."}}
```

The normal Chat form uses `insufficient_chat_credit` and `credit_bucket:
"chat"`; realtime Voice uses only `insufficient_voice_credit` and
`credit_bucket: "voice"`.
`SWICO_INTERNAL_TEST_EMAILS` accounts bypass wallet capacity checks, but still
create billing-exempt usage audit rows and remain subject to provider, safety,
rate-limit, and configuration controls. Preflight is not a reservation: the
WebSocket transaction still locks and reserves after connection, so a race is
handled with one targeted error and application close code.

The response contains a short-lived one-use ticket and a WebSocket URL without
the ticket. The browser adds the query value only when constructing the socket.
Only a SHA-256 ticket digest and minimal session metadata are held in the
existing private Valkey. Origin must exactly match the effective CORS origin
list: the HTTPS-only `CORS_ALLOW_ORIGINS` production list plus any explicitly
configured loopback-only `CORS_ALLOW_LOCAL_DEV_ORIGINS` values. A local Vite
frontend may use `http://localhost:5173,http://127.0.0.1:5173` in that dedicated
variable; a
per-user compare-and-delete lock allows one session. Retry fully closes the old
socket/media and always calls the ticket endpoint again.

The browser installs message/error/close listeners before waiting for the 101,
uses a 12-second open deadline, and sends protocol-v1 JSON `ping` every 20
seconds while connected. HTTPS requires `wss:`; `ws:` is accepted only on HTTP
development. Host and path must match the configured API or an explicitly
approved host. Cleanup stops keepalives. Retry obtains a fresh ticket; completed
billable turns are never auto-reconnected.

Configured Valkey failure never falls back to process memory in production:

```json
{"error":{"code":"voice_ticket_store_unavailable","message":"Voice Mode is temporarily unavailable."}}
```

Never log tickets, Firebase tokens, headers, API keys, raw audio, transcript,
assistant text, email, provider response bodies, or payment secrets. Safe Voice
diagnostics contain only stage, exception class, provider category, canonical
safe code, WebSocket close code/handshake status/retryable flag, 512-sample
frame/message counts, duration, turn number, cleanup result, and
reservation-release result. Ticket creation logs only request ID, backend release, tier/language
identifiers, billing-exempt boolean, HTTP status, safe duration, and an outcome
category—never content, identity, balances, tickets, or secrets. Allowed stages are `ticket_consumed`, `session_started`,
`stt_reservation`, `sarvam_stt_connect`, `microphone_stream`,
`endpoint_pending`, `chat_prepare`, `chat_generate`, `sarvam_tts_connect`,
`tts_stream`, `settlement`, and `client_disconnect`.

## Protocol version 1

Client JSON messages are `session.start`, `turn.end`, `mute`, `unmute`, `ping`,
and `session.close`. `interrupt` is accepted for backwards compatibility but
does not interrupt an answer: only Sarvam `START_SPEECH` is authoritative.
Microphone frames are exactly a four-byte big-endian sequence plus 512 signed
little-endian 16-bit mono samples: 1,024 PCM bytes and 32 ms at 16 kHz.
Duplicate/out-of-order sequences and non-512-sample frames are ignored/rejected.
The stateful linear resampler accepts browser rates including 44.1, 48, and
96 kHz, carries fractional phase across 128-sample render quanta, and retains
only bounded interpolation/frame residuals. It emits only full 512-sample
frames; shutdown deliberately drops (never emits) the final partial frame.

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
{"protocol_version":1,"type":"audio.start","content_type":"audio/mpeg","codec":"mp3","sample_rate":null,"channels":1,"sample_format":null,"playback_mode":"buffered_mp3","turn_number":1}
{"protocol_version":1,"type":"audio.end","turn_number":1,"codec":"mp3","chunks_sent":8,"bytes_sent":32768,"characters":42,"interrupted":false}
{"protocol_version":1,"type":"turn.done","thread_id":"...","user_message_id":"...","assistant_message_id":"...","turn_number":1,"input_mode":"realtime_voice","completion_status":"complete"}
```

`audio.end` means provider output is complete, not browser playback is complete.
Every binary message remains a four-byte big-endian sequence followed by the
provider payload. In the default `buffered_mp3` mode the browser never uses
MediaSource: it rejects duplicates, detects gaps, retains at most 8 MiB/96
chunks, concatenates them in sequence order only after `audio.end`, creates one
`audio/mpeg` Blob URL, and calls `play()` only after attaching that URL. The UI
stays Speaking until `ended`. Autoplay rejection retains the same Blob and URL
for **Tap to play**; decode failure permits one manual replay from the same Blob;
Skip, barge-in, close, retry, thread teardown, page unload, and unmount pause and
revoke it. None of these paths requests or bills TTS again.

`pcm_stream` carries raw mono signed 16-bit little-endian samples with no
per-chunk WAV header. A dedicated AudioContext converts Int16 to Float32,
creates one-channel AudioBuffers declared at the provider sample rate, and
schedules sources against a monotonic clock with a 160 ms initial jitter
buffer. The browser performs sample-rate conversion when its device rate
differs. `audio.end` waits for the final scheduled source. Suspended contexts
retain queued PCM for **Tap to enable audio**. Barge-in stops all source nodes,
clears unscheduled PCM, and resets the schedule.

`auto` may use MediaSource only when the session request reports Web Audio and
MP3 MediaSource capability and `MediaSource.isTypeSupported("audio/mpeg")`
agrees locally. A complete ordered MP3 copy is retained independently. Failure
before audible playback falls back to the complete Blob at `audio.end`; failure
after audible playback stops the progressive element and offers **Replay full
spoken answer** from the beginning. MediaSource is therefore an optimization,
never the sole production decoder.

The hook tracks server voice state separately from local playback. A server
Listening transition cannot override local Speaking while an element or PCM
source remains active; microphone forwarding stays gated except through the
existing provider-confirmed barge-in path.

`turn.done` is emitted only after both ordinary chat messages are complete and
the Voice-bucket LLM reservation is settled. The web app activates a new Voice-created
thread, reloads authoritative messages by public ID, refreshes the thread list
and wallets, and repeats that authoritative refresh on close. Failed/cancelled
turns are not presented as complete; completed turns are never deleted by End
conversation and survive browser refresh.

## Endpointing, gating, barge-in, and accounting

Every billable realtime turn component uses the Voice wallet: STT is
`usage_kind=stt`, LLM response generation is `usage_kind=chat` with
`credit_bucket=voice`, and TTS is `usage_kind=tts`. The trusted WebSocket path
sets this internal bucket explicitly. The public Chat endpoint remains
authoritatively Chat-billed even if a caller submits realtime-voice metadata.
TTS may reserve incrementally; if Voice credits run out, the completed text is
preserved and the existing Voice-credit warning is shown.

After permission, a 300–500 ms local-only calibration estimates noise floor.
Those samples are never uploaded or billed. Authenticated bootstrap supplies
bounded threshold multiplier/minimum/maximum, quiet-speaker fallback, and the
no-speech warning duration. The UI displays a local microphone meter and “We
cannot hear you” after the bound only while listening/endpoint-pending. STT
activity, thinking/speaking, mute, accepted local speech, or close clears it.
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
are accumulated exactly once. Provider `END_SPEECH` or a final transcript is a
candidate boundary, not a committed end of turn. The application enters
`endpoint_pending`, continues accepting microphone/provider input, and starts a
generation-checked adaptive deadline. A new `START_SPEECH` invalidates and
cancels the old deadline, keeps accumulated final segments and new audio in the
same user turn, and returns smoothly to Listening. Partial or final updates
also invalidate and recalculate the timer from that latest meaningful evidence,
so Thinking never begins merely because of a short pause.

The transcript classifier returns `complete`, `neutral`, or `unfinished`.
English continuation examples include “and”, “but”, “because”, “if”, “to”,
“actually”, “well”, “um”, and “uh”. Tamil examples include “மற்றும்”, “ஆனால்”,
“ஏனெனில்”, “என்றால்”, “என்று”, “அப்புறம்”, “ஆனா”, and “அதனால”. A trailing
comma, colon, dash, or ellipsis is unfinished. Terminal punctuation supports
completion but is not required because provider punctuation is probabilistic;
recently changing partials and partials longer than accumulated finals remain
unstable.

For each already accepted 512-sample, 16 kHz PCM frame, the backend retains at
most about 1.44 seconds of scalar RMS/dBFS, zero-crossing, voicing, and bounded
autocorrelation pitch measurements. Pitch work runs only every third frame in
the 70–400 Hz range. Terminal cadence requires several confident voiced pitch
measurements, a roughly 1.25-semitone fall across windows, and non-rising
energy. Gradually falling energy plus declining voicing can mark trailing-off.
One noisy frame or rising pitch cannot shorten a deadline. These are weak
prosodic timing cues—not emotion, intent, or semantic understanding—and they
only adjust a bounded timer; they never finalize a turn by themselves.

With recommended tuning, complete terminal cadence uses about 850 ms, complete
neutral speech 1,100 ms, unstable/neutral text about 1,500 ms, unfinished text
2,000 ms, and incomplete trailing-off evidence up to 2,600 ms. Every wait is
capped by `MAX_ENDPOINT_WAIT_MS` and the 30-second utterance maximum. Explicit
`turn.end` commits immediately; maximum duration commits usable speech safely;
empty/noise-only turns are discarded. Setting adaptive endpointing false
restores the prior fixed base-plus-unfinished-grace behavior.

Every provider PCM byte is forwarded only while an STT reservation or explicit
billing-exempt audit row is active. Reservation expansion commits before audio
forwarding. After endpointing, consumed gated audio is settled once and the
next turn is reserved before thinking/speaking so provider-confirmed barge-in
cannot become unreserved audio. Silence suppressed by the browser is neither
sent nor billed. Prosody reuses those same accepted PCM frames locally: it
creates no provider request, reservation, usage charge, stored audio, or billed
pause duration. Endpoint timer recalculation is not usage. TTS reserves before
sending text, expands idempotently, settles
submitted characters, and releases unused remainder. Disconnect/interruption
cancels and awaits tasks, releases every live reservation, closes providers,
and compare-deletes the Valkey lock.

Sarvam wire behavior follows the official [streaming STT guide](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/streaming-api), [STT WebSocket reference](https://docs.sarvam.ai/api-reference/speech-to-text/transcribe/ws), installed `sarvamai` SDK 0.1.28, and [TTS WebSocket reference](https://docs.sarvam.ai/api-reference/text-to-speech/stream). The current endpoints are `/speech-to-text/ws` and `/text-to-speech/ws`; both use `Api-Subscription-Key`. STT declares `input_audio_codec=pcm_s16le` and `sample_rate=16000` in the query. Each base64 raw-PCM message also declares `sample_rate: 16000`, while its SDK/documented envelope field defaults to `encoding: audio/wav`. `SARVAM_STT_STREAM_MESSAGE_ENCODING` may select only `audio/wav` or `pcm_s16le`; production never auto-switches or replays audio. VAD/flush, START/END speech, partial/final transcript, and safe error/close normalization remain continuous. TTS sends config first with language/speaker/MP3 codec, then text, flush, and documented JSON application `ping`; it decodes progressive audio and stops on completion. Application ping is distinct from a WebSocket protocol control ping.

Provider JSON/body content is never surfaced. Bounded scalar code/status fields
normalize to `invalid_audio_encoding`, `invalid_audio_frame`,
`invalid_sample_rate`, `invalid_message`, `authentication_failed`,
`quota_exhausted`, `rate_limited`, `provider_internal`, `abnormal_close`, or
`unknown_provider_error`. HTTP 400/404/405/415/422/426 and protocol closes are
protocol; 401/403 are authentication; 429/quota codes are quota; and
1006/1011/network failures are temporary.

## Stable errors and close codes

| Code | Close | Meaning |
| --- | ---: | --- |
| `voice_protocol_mismatch` | 4400 | unsupported client protocol |
| `voice_session_expired` | 4401 | invalid, expired, or consumed ticket |
| `voice_origin_rejected` | 4403 | Origin rejected |
| `voice_session_active` | 4409 | existing active user session |
| `voice_rate_limit` | 4429 | Voice start/turn rate limit |
| `voice_server_update_required` | 4450 | legacy server response; refresh/update guidance only |
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
credit errors. A fixed server does not emit `insufficient_chat_credit` during
Voice Mode. Clients retain 4450 for one rolling-deployment compatibility window
and map it to generic refresh guidance without a Chat purchase action.
`microphone_permission_denied` is a browser-local structured error. The first
structured error always wins over a later socket close.

## Environment

```dotenv
WEB_REALTIME_VOICE_ENABLED=false
WEB_REALTIME_VOICE_PLAYBACK_MODE=buffered_mp3
SARVAM_TTS_STREAM_OUTPUT_CODEC=mp3
SARVAM_TTS_STREAM_SAMPLE_RATE=24000
WEB_SEPARATE_VOICE_CREDITS_ENABLED=false
WEB_REALTIME_VOICE_SESSION_TICKET_TTL_SECONDS=60
WEB_REALTIME_VOICE_MAX_SESSION_SECONDS=900
WEB_REALTIME_VOICE_IDLE_TIMEOUT_SECONDS=60
WEB_REALTIME_VOICE_MAX_CONCURRENT_SESSIONS_PER_USER=1
WEB_REALTIME_VOICE_START_RATE_LIMIT_PER_MINUTE=5
WEB_REALTIME_VOICE_ADAPTIVE_ENDPOINTING_ENABLED=true
WEB_REALTIME_VOICE_END_SILENCE_MS=1100
WEB_REALTIME_VOICE_UNFINISHED_GRACE_MS=900
WEB_REALTIME_VOICE_MAX_ENDPOINT_WAIT_MS=2600
WEB_REALTIME_VOICE_MIN_SPEECH_MS=250
WEB_REALTIME_VOICE_MAX_UTTERANCE_MS=30000
WEB_REALTIME_VOICE_BARGE_IN_MIN_MS=180
WEB_REALTIME_VOICE_PREROLL_MS=320
SARVAM_STT_STREAM_MESSAGE_ENCODING=audio/wav
WEB_VOICE_GATE_CALIBRATION_MS=400
WEB_VOICE_GATE_NOISE_MULTIPLIER=2.4
WEB_VOICE_GATE_THRESHOLD_MIN=0.012
WEB_VOICE_GATE_THRESHOLD_MAX=0.065
WEB_VOICE_GATE_QUIET_FALLBACK=0.008
WEB_VOICE_NO_SPEECH_WARNING_MS=10000
```

Authenticated bootstrap also returns safe `backend_release` and
`voice_protocol_version`. Vite embeds the first 12 characters of
`RENDER_GIT_COMMIT` (local fallback `dev`) without a manually maintained
`VITE_*` flag. When both non-dev releases exist and differ, only billable Voice
start is blocked with refresh guidance; ordinary text chat continues.

### Internal readiness diagnostics

`GET /api/web/voice/diagnostics` authenticates and loads the owned user, then
returns 404 unless `is_internal_test_user(...)` is true. Its no-store response
makes no provider call and includes only safe release/protocol/Alembic
identifiers, feature/auth booleans, wallet preflight counts, Valkey/Sarvam
configuration readiness (including playback mode, selected operator codec, and
provider sample rate), exact configured origins, and expected WebSocket
scheme/path. Session status is limited to `active_session` and
`remaining_lock_ttl_seconds`. The internal UI additionally shows the selected
device label after permission, browser/resampled rates, RMS, noise floor,
threshold, emitted frames, backpressure drops, safe endpoint classification,
terminal-cadence/trailing-off booleans, voiced duration, selected delay/reason,
deadline generation/cancellation count, safe MediaError category/code,
allowlisted DOMException name, failure stage, chunk/byte/sequence counts,
first-chunk/playback timings, fallback/autoplay state, scheduled PCM seconds,
active sources, and playback completion. It excludes email, Firebase UID,
ticket, credentials/URLs, header dumps, transcript text, raw PCM, pitch history,
audio, and provider bodies.

The diagnostic Chat entry is informational: its required micros are zero and it
is explicitly marked not required for realtime Voice. The Voice entry reports
the combined five-second STT plus minimum tier LLM requirement.

### Explicit live provider probe

The default tests, CI, startup, and deployment never run a live provider call.
An operator may deliberately run this billable interoperability check from
`backend/`:

The `--language` choices are the website reply-language set: `en`, `ta`,
`tanglish`, `hi`, `bn`, `te`, `kn`, `ml`, `mr`, `gu`, `pa`, and `od`. STT
probes always request provider auto-detection; the language selects only the
TTS probe text and output voice path.

```bash
ALLOW_LIVE_SARVAM_VOICE_PROBE=true .venv/bin/python -m scripts.voice_provider_probe --mode stt --language en
ALLOW_LIVE_SARVAM_VOICE_PROBE=true .venv/bin/python -m scripts.voice_provider_probe --mode tts --language en --output-codec mp3 --sample-rate 24000 --validate-audio
ALLOW_LIVE_SARVAM_VOICE_PROBE=true .venv/bin/python -m scripts.voice_provider_probe --mode both --language ta --payload-encoding audio/wav --output-codec linear16 --sample-rate 24000 --validate-audio
ALLOW_LIVE_SARVAM_VOICE_PROBE=true .venv/bin/python -m scripts.voice_provider_probe --mode stt --language en --audio-file /safe/local/operator-fixture.wav
ALLOW_LIVE_SARVAM_VOICE_PROBE=true .venv/bin/python -m scripts.voice_provider_probe --mode tts --language ta --output-codec mp3 --validate-audio --temporary-output /explicit/operator/path/swico-probe.mp3
```

It also requires `SARVAM_API_KEY`, refuses without the exact guard, and prints
only safe booleans/counts/codes—never transcripts, generated text, audio,
base64, keys, headers, URLs,
or provider response bodies. A synthetic run reports `protocol_accepted` only
after a safe speech/transcript event; otherwise it reports
`inconclusive_no_speech` and exits non-zero. `provider_error` and abnormal close
always fail. Payload comparison is an explicit separate operator invocation,
never an automatic retry within a customer operation. Example mocked shape:

```json
{"ok":true,"tts":{"codec":"linear16","sample_rate":24000,"channels":1,"chunks_received":6,"bytes_received":48000,"samples_received":24000,"estimated_duration_ms":1000,"completion_event_received":true,"provider_safe_code":null,"provider_close_code":null}}
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

Before the live smoke, `GET /api/version` must report the deployed repository
the previously deployed head `20260915_weekly_tester_credit` for both Alembic current and head, with
`ok: true`.
Use the internal diagnostics endpoint/panel to verify
matching frontend/backend releases, the repository's current Alembic head `20260917_cli_cloud_artifacts` (or the deployed prior head before that migration is applied), all three
Voice features, billing exemption, Valkey and Sarvam configuration, and Origin.
In DevTools filter `voice/sessions` or **All**, not only `ws`, so prerequisite
HTTP 201/402/409/503 remains visible. Ignore extension `background.js`, service
worker, and unrelated preload warnings.

If a prior attempt ended before the socket could consume/release its lock, wait
the diagnostic `remaining_lock_ttl_seconds` (ticket TTL defaults to 60 seconds),
refresh diagnostics until `active_session=false`, then request a fresh ticket.
Do not reuse a ticket and do not add or call a public lock-deletion endpoint.

Endpoint-only rollback: set
`WEB_REALTIME_VOICE_ADAPTIVE_ENDPOINTING_ENABLED=false` on the existing API
service and deploy the API before changing the web service. This preserves the
working fixed-silence Voice path. No migration, new service, database, Valkey,
or Cron Job is involved.

Immediate feature disable: set `WEB_REALTIME_VOICE_ENABLED=false` on the
existing API service and deploy the API configuration. Bootstrap removes the
entry point; existing ordinary chat/history and wallet data remain intact.
Fix forward—do not roll back the database. Checkout remains disabled pending
legal publication and payment verification.

### Staged playback rollout

Stage 1 is the production-safe default and is backward compatible when the new
variables were previously absent:

```dotenv
SARVAM_TTS_STREAM_OUTPUT_CODEC=mp3
WEB_REALTIME_VOICE_PLAYBACK_MODE=buffered_mp3
SARVAM_TTS_STREAM_SAMPLE_RATE=24000
```

Only after both English and Tamil LINEAR16 probes succeed, Stage 2 is:

```dotenv
SARVAM_TTS_STREAM_OUTPUT_CODEC=linear16
SARVAM_TTS_STREAM_SAMPLE_RATE=24000
WEB_REALTIME_VOICE_PLAYBACK_MODE=pcm_stream
```

Allowed playback modes are `buffered_mp3`, `pcm_stream`, and `auto`; operator
codecs are `mp3` and `linear16`; sample rates are `8000`, `16000`, `22050`, and
`24000`. The installed official `sarvamai 0.1.28` generated schema and socket
serializer send `linear16` unchanged. A current narrative WebSocket guide also
uses the label `pcm` for LINEAR16, so the provider adapter owns the wire mapping
and Stage 2 remains gated on the explicit PCM probe. A codec is fixed in the
one-use authenticated session before TTS and never changes during a paid turn.
