# Real-time Voice Mode protocol

Real-time Voice Mode is an authenticated web feature. The browser never opens
a provider socket and never receives a Sarvam credential. Sarvam supplies
streaming speech recognition and synthesis; the persisted Swico tier still
generates the answer through the same chat service and billing path as HTTP
chat.

## Session handshake

With both feature flags enabled, the authenticated browser requests a one-use
ticket:

```http
POST /api/web/voice/sessions
Authorization: Bearer <Firebase ID token>
```

```json
{
  "protocol_version": 1,
  "session_id": "6b1a7f1e-6f55-4dc4-bb8f-705fa1fbb5d7",
  "ticket": "<short-lived one-use value>",
  "websocket_url": "wss://api.example.com/api/web/voice/ws",
  "expires_at_epoch": 1784439000,
  "tier": "standard",
  "tier_label": "Swico",
  "language": "ta",
  "wallet": { "credit_bucket": "chat", "available_micros": 5000000 },
  "wallets": {
    "chat": { "credit_bucket": "chat", "available_micros": 5000000 },
    "voice": { "credit_bucket": "voice", "available_micros": 2000000 }
  }
}
```

The client connects to
`/api/web/voice/ws?ticket=<one-use-ticket>`. Only the SHA-256 ticket digest and
minimal session metadata are kept in the existing Valkey. The ticket is
atomically consumed, Origin must exactly match `CORS_ALLOW_ORIGINS`, and a
per-user lock allows one active session. Tickets, Firebase tokens, user IDs,
provider keys, transcripts, answer text, and audio are not logged or stored in
Valkey. Render starts Uvicorn without query-string access logs; the application
retains path/status telemetry.

## Version 1 messages

Every JSON message contains `"protocol_version": 1` and a `type`. A start and
turn can look like:

```json
{"protocol_version":1,"type":"session.start","thread_id":"<optional UUID>","audio":{"encoding":"pcm_s16le","sample_rate":16000,"channels":1}}
{"protocol_version":1,"type":"turn.end"}
{"protocol_version":1,"type":"interrupt"}
{"protocol_version":1,"type":"mute"}
{"protocol_version":1,"type":"unmute"}
{"protocol_version":1,"type":"ping"}
{"protocol_version":1,"type":"session.close"}
```

Microphone frames are binary: four-byte unsigned big-endian sequence number,
followed by bounded 16 kHz, mono, signed 16-bit PCM. Duplicate/out-of-order
sequence numbers are ignored. The client caps WebSocket buffered bytes and the
server caps each frame and provider queues.

Representative server messages are:

```json
{"protocol_version":1,"type":"session.ready","state":"listening","turn_number":1}
{"protocol_version":1,"type":"stt.partial","transcript":"வண...","turn_number":1}
{"protocol_version":1,"type":"stt.final","transcript":"வணக்கம்","turn_number":1}
{"protocol_version":1,"type":"assistant.start","turn_number":1}
{"protocol_version":1,"type":"assistant.delta","delta":"வணக்கம்!","turn_number":1}
{"protocol_version":1,"type":"audio.start","content_type":"audio/mpeg"}
{"protocol_version":1,"type":"audio.end","characters":42}
{"protocol_version":1,"type":"wallet.updated","wallets":{"chat":{},"voice":{}}}
{"protocol_version":1,"type":"turn.done","turn_number":1,"thread_id":"...","message_id":"..."}
{"protocol_version":1,"type":"warning","code":"assistant_interrupted","message":"Assistant interrupted."}
{"protocol_version":1,"type":"error","code":"insufficient_voice_credit","credit_bucket":"voice","message":"Add Voice credits to continue."}
{"protocol_version":1,"type":"session.closed","reason":"client_closed"}
```

Progressive MP3 frames use the same four-byte sequence prefix. A browser
barge-in stops playback immediately, sends `interrupt`, and cooperatively
cancels generation/TTS. Completed text remains in history even if synthesis
fails or Voice credit is exhausted. The server settles submitted/consumed
usage and releases unused reservations on interruption, provider failure,
timeout, and disconnect. Reconnect is never automatic: it requires a fresh
ticket so a prior turn cannot be replayed or billed twice.

## Configuration and deployment

The backend variables and defaults are:

```dotenv
WEB_REALTIME_VOICE_ENABLED=false
WEB_SEPARATE_VOICE_CREDITS_ENABLED=false
WEB_REALTIME_VOICE_SESSION_TICKET_TTL_SECONDS=60
WEB_REALTIME_VOICE_MAX_SESSION_SECONDS=900
WEB_REALTIME_VOICE_IDLE_TIMEOUT_SECONDS=60
WEB_REALTIME_VOICE_MAX_CONCURRENT_SESSIONS_PER_USER=1
WEB_REALTIME_VOICE_START_RATE_LIMIT_PER_MINUTE=5
```

No new service, database, Valkey, Cron Job, disk, or object storage is needed.
Deploy migration `e2b7c4d9a1f3`, the API, and the three existing financial job
code paths before the static site. Keep checkout and both feature flags off
during migration and verification. CSP must allow `wss:`, media must allow
`blob:`, and the static site's Permissions Policy must allow
`microphone=(self)`. There is no public Vite voice flag or WebSocket URL.
