# Website template videos

This product is separate from Chat, Voice, CLI, subscriptions and Windows Free
inference. Both video switches default off. It needs the existing API, PostgreSQL,
private `WEB_UPLOAD_CACHE_URL` Valkey and an outbound-only Intel Mac. No new Render
service or media/object-storage provider is involved. Source code/tests are not
proof of commercial rights, native likeness/quality, provider acceptance or an SLA.
`videoLegalDraft.json` is a non-published proposal; the released Chat policies stay
unchanged. Video admission additionally requires those proposal pages to be
published under the existing exact-content legal approval validation.

## Runtime paths

`/videos` → verified owned email → frozen template/options → role-specific raw
image PUT → Mac preflight → explicit complimentary/paid admission → fenced Mac
render → binary output PUT → verified finalization → ordinary chat card + durable
email intent → private MP4 fetch. `/api/web/videos/*` never calls face models.
`/api/video-worker/v1/*` is a separate token-scoped queue, not generic `Job` or the
Windows queue. Video orders are created ONLY by `/jobs/{id}/admit`, not the wallet
order route: this prevents bypassing consent, preflight and capacity.

The new tables are `video_control`, `video_template`, `video_quota`, `video_job`,
`video_outbox`. The singleton control row serializes short admissions and claims
across API replicas. Worker claims use row locks and attempt/fence/lease checks.
Only one preflight/render may run at a time. Paid/admitted renders precede unpaid
preflights. Native work runs in a child process while the parent renews leases;
loss of heartbeat kills its process group. An inherited liveness pipe kills the
native group if the supervisor crashes, and the child retains the local flock
until exit so launchd cannot start overlapping inference. At most three attempts use the same
funding reservation. A deadline or exhausted recovery produces compensation.

## Eligibility and money

Every verified website account, including Free, can explicitly buy one video for
₹25 **total** (2500 paise). Guests/unverified/mismatched token and database emails
cannot. Unlimited video membership is a separate explicit email list; existing
weekly tester membership gives five attempts per Asia/Kolkata calendar day.
It does not read/debit the remaining weekly Chat balance. Unlimited takes priority.
Capacity still applies: one outstanding/account, six globally, six preflights/hour.

Complimentary quota is reserved under the admission lock, consumed at first
processing, restored once for infrastructure failure or pre-processing cancellation.
After-start user cancellation does not restore consumed free attempts. A new day
uses a new quota row; retries retain their original reservation. Exhaustion never
opens an automatic checkout. The separate Pay ₹25 button is deliberate consent.

`PaymentOrder.purchase_type=video_template`, `credit_bucket=NULL`, zero wallet
credit and platform-allocation fields, and a unique job/payment association prevent
wallet/referral/subscription fulfillment. Capture verification and the existing
signed webhook converge on the same dispatcher. Unknown products fail closed.
An `order.paid` without payment identity fetches the captured payment before use.
Checkout holds expire after five minutes; late capture initiates compensation.
Never describe gross video revenue as net profit.

Refunds use the official Razorpay `POST /v1/payments/{id}/refund`, `speed=normal`,
fixed amount and stable `receipt`. No invented idempotency header. Durable intent
precedes POST. GET reconciliation precedes retries; an ambiguous POST without a
matching receipt is `manual_review`, never blindly reissued. Only provider
`processed` or its authenticated webhook updates the processed-refund total.
Partial refunds stop execution and require review. No refund adds wallet credit.
SMTP has a separate bounded outbox, stable Message-ID and expiry cutoff; ambiguous
SMTP retry may duplicate an email, never a generation/payment.

## Input, engine and review policy

Grammar: one directive per line, `swap: both|male|female`, `enhance: natural|off`,
`caption: printable text` (100 characters). Colons/quotes/percent signs in caption
are literal text, not ffmpeg expressions. Initial caption font coverage is printable
ASCII; unsupported text fails **before checkout**. No location/costume/speech/action
editing. Images: JPEG/PNG/WebP, single frame, ≥64px each dimension, ≤12 megapixels,
raw ≤5 MiB, metadata-free normalized JPEG ≤2 MiB. Explicit consent covers both
adult source subjects; exactly one usable face/photo. No demographic classifier
is executed. Safety analysis is required on sources and every template frame.

The pinned engine is FaceFusion 3.0.1 commit
`03d49d0c7de095a41628a74d94a146214f82837a`. Its published headless dependency subset
uses Python 3.12, NumPy 2.1.0, ONNX 1.16.1, ORT 1.19.2 CPU and OpenCV 4.10.0.84.
These historical pins need operator security/support review. Gradio is not used.
Setup refuses unavailable binary wheels; it does not force ARM/CUDA/MPS or silently
substitute another engine. Native full-model execution is a separate acceptance.

Required model inventory: inswapper_128, arcface_w600k_r50, retinaface_10g,
2dfan4, fan_68_5, dfl_xseg, bisenet_resnet_34, gfpgan_1.4, open_nsfw. Every exact
ONNX asset requires source, SHA-256, licence document/hash, commercial-permission
document/hash, named reviewer/date. Engine code has its own review record.
The licence skeleton is deliberately unapproved. A file hash proves document
integrity, **not** that a legal grant is genuine or sufficient. InsightFace code
licensing is not commercial permission for pretrained weights. Template video
and audio modification/distribution rights require separate evidence. Counsel
must assess the complete pipeline; no alternative weights are automatically cleared.

Templates are imported locally. `prepare` detects cuts and associates detections
within shots using bounded box motion plus local face features, with an ambiguity
stop rather than a confident guess. It produces annotated frames and editable
tracks. Use `templates tracks status`, `reassign`, `exclude` or `split` for
crossings, re-entry and occlusion corrections; these commands are local,
atomic, never change `master.mp4`, and invalidate approval/calibration.
`review` requires explicit male/female/exclude labels and per-frame review; these
are reviewed role tracks, not performer names or identity recognition. Bad joins
must be split/corrected locally before approval. Background tracks default exclude.
During rendering both roles match the ORIGINAL frame detections. Swaps use
occlusion masks; deltas are composited before one final H.264 encode with original
audio. Actual occlusion/likeness/flicker quality still requires viewing each clip.

Initial masters must have constant frame PTS, even dimensions, 1–30s, 1–60fps,
64–1920px. Variable-frame-rate material is refused for explicit local preparation,
not silently retimed. Dimensions/aspect/frame count and A/V duration are checked.
Customer frames stream one at a time; they are never template analysis or face-library
entries. Each output carries `Swico · AI-edited`. No personal sources are published.

Three or more **real** full-clip warm trials/template for EACH enhancement mode
and separate first-render/model-load measurements precede publication.
Approval binds media/tracks/profile/rights/rendering code; changes
invalidate it. Estimates include measured model-load and first/warm full-clip
render times plus a conservative 30% operational/transfer margin (a policy buffer,
not a measured transfer benchmark),
running elapsed time and jobs ahead. They are not p90 or guaranteed delivery times;
stale workers pause estimates and new admissions. No benchmark values ship here.

## Retention and failure boundaries

`swico:video:*` is a separate binary-safe Redis client/namespace. Never modify
ordinary chat uploads' hard 300-second ceiling, JSON/base64 schema or global Redis
eviction policy. Media request bodies stream into explicitly bounded memory, not
multipart/disk. Two binary transfers at a time per API process bound concurrent
in-memory copies, with release on disconnect. There are no DB media columns.
Each active job reserves 20 MiB,
bounded by the 128 MiB video budget and actual Redis headroom (32 MiB minimum left
for other workloads plus a new reservation). Unknown/unbounded maxmemory refuses
admission. Configure existing service capacity deliberately, never flush chat keys.

Unpaid sources: at most ten minutes. Admission atomically verifies/pins all selected
source keys through a fixed job deadline (up to four hours). Cross-store failure
prevents checkout or creates compensation; Redis is not the authoritative paid
queue. Source bytes are immutable after upload. MP4 ≤16 MiB: idempotent bounded PUT
then SHA/structural verification and retrievability before database READY. Native
worker additionally performs decode validation. First READY starts an immutable
600-second window and retains its cache reservation through that window; no
refresh/email/reconnect extends it. Every Range/download
reauthenticates ownership and expiry; expired owners receive 410, others 404.

Terminal source keys are deleted. The Mac deletes customer scratch data after each
attempt and sweeps owned UUID scratch directories on restart. Outputs remain in
Valkey for the promised remaining window even if Mac powers off. Lost artifacts
before expiry become non-delivery/refund recovery, not a broken download button.
Browser object URLs are revoked at expiry/account change/unmount. An offline Mac
cannot physically unlink at a wall-clock deadline; restart cleanup is mandatory.
Unlink is not SSD secure erasure. Redis TTL is access expiry, not deletion from
managed snapshots/backups. Operator MUST inspect existing Valkey persistence,
snapshot/backup and eviction settings and publish the real residual-retention
policy. Downloaded customer copies cannot be revoked.

## Primary references checked

- [Pinned engine dependencies](https://github.com/facefusion/facefusion/blob/03d49d0c7de095a41628a74d94a146214f82837a/requirements.txt)
- [FaceFusion licence inventory](https://docs.facefusion.io/introduction/licenses)
- [InsightFace pretrained-model restrictions](https://github.com/deepinsight/insightface#license)
- [Official Razorpay refund contract](https://github.com/razorpay/razorpay-python/blob/master/documents/refund.md)
- [ORT 1.19.2 artifacts](https://pypi.org/project/onnxruntime/1.19.2/)

See VIDEO_MAC_SETUP.md and VIDEO_RELEASE_CHECKLIST.md. No live licence, template,
provider, SMTP or native inference acceptance is inferred from deterministic tests.
