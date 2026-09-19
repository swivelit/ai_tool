import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Film } from 'lucide-react'
import { useAuth } from '../auth/useAuth'
import { apiJson } from '../api/client'
import { loadRazorpay } from '../billing/razorpay'
import { VideoCard } from '../video/VideoCard'
import type { VideoCapabilities, VideoJob } from '../video/types'
import { DEFAULT_INSTRUCTIONS, formatSupportedInstructions, parseSupportedInstructions } from '../video/instructions'
import '../video/video.css'

type Checkout = { key_id: string; amount: number; currency: string; provider_order_id: string; internal_order_id: string }
type ConsentKey = 'requesterAdult' | 'sourceFacesAdult' | 'sourceFacePermission' | 'sourcePhotoRights' | 'syntheticMedia' | 'prohibitedUse' | 'retention' | 'disclosure'
type ConsentState = Record<ConsentKey, boolean>
const emptyConsent: ConsentState = { requesterAdult: false, sourceFacesAdult: false, sourceFacePermission: false, sourcePhotoRights: false, syntheticMedia: false, prohibitedUse: false, retention: false, disclosure: false }
function editSummary(options: VideoJob['options']) {
  const role = options.swap === 'both' ? 'both selected roles' : `${options.swap} role`
  const enhancement = options.enhance === 'natural' ? 'with conservative natural enhancement' : 'with enhancement off'
  const caption = options.caption ? ` and the caption “${options.caption}”` : ' and no caption'
  return `Replace the ${role} in the reviewed template ${enhancement}${caption}.`
}
export function VideosPage() {
  const { user } = useAuth()
  const [caps, setCaps] = useState<VideoCapabilities | null>(null)
  const [template, setTemplate] = useState('couple-01')
  const [swap, setSwap] = useState('both')
  const [enhance, setEnhance] = useState('off')
  const [caption, setCaption] = useState('')
  const [instructionText, setInstructionText] = useState(DEFAULT_INSTRUCTIONS)
  const [photos, setPhotos] = useState<Record<string, File>>({})
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [consent, setConsent] = useState<ConsentState>(emptyConsent)
  const [job, setJob] = useState<VideoJob | null>(null)
  const [jobs, setJobs] = useState<VideoJob[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const submitting = useRef(false)
  const requestKey = useRef(crypto.randomUUID())
  const previewUrls = useRef<Record<string, string>>({})
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const capabilityRequest = useRef(0)
  const capabilityInFlight = useRef(false)
  const clearPreviews = useCallback(() => {
    Object.values(previewUrls.current).forEach(value => URL.revokeObjectURL(value))
    previewUrls.current = {}
    Object.values(inputRefs.current).forEach(input => { if (input) input.value = '' })
    setPreviews({})
  }, [])
  useEffect(() => {
    const id = ++generation.current
    setJob(null); setJobs([]); setCaps(null); setPhotos({}); clearPreviews(); setConsent(emptyConsent); setError(''); setBusy(false); setInstructionText(DEFAULT_INSTRUCTIONS); setSwap('both'); setEnhance('off'); setCaption('')
    submitting.current = false; requestKey.current = crypto.randomUUID()
    if (!user) return
    const controller = new AbortController()
    let retry = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const [cap, list] = await Promise.all([apiJson<VideoCapabilities>(user, '/api/web/videos/capabilities', { signal: controller.signal }), apiJson<{ items: VideoJob[] }>(user, '/api/web/videos/jobs', { signal: controller.signal })])
        if (id !== generation.current) return
        setCaps(cap); setJobs(list.items)
        setJob(list.items.find(item => !['ready', 'expired', 'failed', 'cancelled', 'refunded', 'refund_pending'].includes(item.state)) ?? null)
        setError(''); retry = 0
      } catch {
        if (controller.signal.aborted || id !== generation.current) return
        setError('Video availability could not be checked. Retrying…')
        if (retry < 3) { retry += 1; retryTimer = setTimeout(() => { void load() }, Math.min(8000, 800 * 2 ** retry)) }
      }
    }
    void load()
    return () => { generation.current = id + 1; controller.abort(); clearTimeout(retryTimer) }
  }, [clearPreviews, user])
  const refreshCapabilities = useCallback(async () => {
    if (!user || capabilityInFlight.current) return
    const id = generation.current
    const request = ++capabilityRequest.current
    capabilityInFlight.current = true
    try {
      const value = await apiJson<VideoCapabilities>(user, '/api/web/videos/capabilities')
      if (id === generation.current && request === capabilityRequest.current) setCaps(value)
    } catch {
      // Keep the last known snapshot during a transient focus/online failure.
    } finally { capabilityInFlight.current = false }
  }, [user])
  useEffect(() => {
    const recover = () => { if (navigator.onLine && document.visibilityState === 'visible') void refreshCapabilities() }
    window.addEventListener('online', recover); window.addEventListener('focus', recover)
    return () => { window.removeEventListener('online', recover); window.removeEventListener('focus', recover) }
  }, [refreshCapabilities])
  useEffect(() => () => clearPreviews(), [clearPreviews])
  const onJobChange = useCallback((value: VideoJob) => {
    setJob(previous => previous?.id === value.id ? value : previous)
    setJobs(previous => previous.map(item => item.id === value.id ? value : item))
    void refreshCapabilities()
  }, [refreshCapabilities])
  const validate = async () => {
    if (!user || !caps || submitting.current) return
    submitting.current = true
    setBusy(true); setError('')
    const id = generation.current
    try {
      const parsed = parseSupportedInstructions(instructionText)
      if (!parsed) throw new Error('Use only swap, enhance and caption on separate lines. Caption is printable ASCII and up to 100 characters.')
      const allConsent = Object.values(consent).every(Boolean)
      const result = await apiJson<VideoJob>(user, '/api/web/videos/jobs', { method: 'POST', body: JSON.stringify({ template_id: template, request_key: requestKey.current, instructions: instructionText, consent: allConsent, adult: consent.requesterAdult, source_faces_adult: consent.sourceFacesAdult, source_face_permission: consent.sourceFacePermission, source_photo_rights: consent.sourcePhotoRights, synthetic_media_acknowledged: consent.syntheticMedia, prohibited_use_acknowledged: consent.prohibitedUse, retention_acknowledged: consent.retention, disclosure_acknowledged: consent.disclosure, policy_version: caps.policy_version, consent_version: caps.consent_version }) })
      if (id !== generation.current) return
      // Even an interrupted upload remains visible/cancellable; no hidden outstanding job.
      setJob(result)
      for (const role of swap === 'both' ? ['male', 'female'] : [swap]) {
        if (id !== generation.current) return
        if (!photos[role]) throw new Error(`Choose a ${role} role photo`)
        await apiJson(user, `/api/web/videos/jobs/${result.id}/photos/${role}`, { method: 'PUT', body: photos[role], headers: { 'Content-Type': 'application/octet-stream' } })
      }
      const validated = await apiJson<VideoJob>(user, `/api/web/videos/jobs/${result.id}/preflight`, { method: 'POST' })
      if (id === generation.current) { setJob(validated); setPhotos({}); clearPreviews(); void refreshCapabilities() }
    } catch (e) { if (id === generation.current) setError(e instanceof Error ? e.message : 'Validation failed') }
    finally { if (id === generation.current) { setBusy(false); submitting.current = false } }
  }
  const admit = async (funding: string) => {
    if (!user || !job || submitting.current) return
    submitting.current = true
    setBusy(true); setError(''); const id = generation.current
    let modalOpen = false
    try {
      const result = await apiJson<{ job: VideoJob; checkout: Checkout | null }>(user, `/api/web/videos/jobs/${job.id}/admit`, { method: 'POST', body: JSON.stringify({ funding }) })
      if (id !== generation.current) return
      setJob(result.job)
      void refreshCapabilities()
      if (result.checkout) {
        await loadRazorpay()
        if (id !== generation.current || !window.Razorpay) return
        const order = result.checkout
        const release = () => { if (id === generation.current) { setBusy(false); submitting.current = false } }
        const checkout = new window.Razorpay({ key: order.key_id, amount: order.amount, currency: order.currency, order_id: order.provider_order_id, name: 'Swico', description: 'One template video · ₹25 total · no wallet credits', modal: { ondismiss: release }, handler: payment => {
          void apiJson(user, '/api/web/billing/verify', { method: 'POST', body: JSON.stringify({ ...payment, internal_order_id: order.internal_order_id }) }).then(() => Promise.all([apiJson<VideoJob>(user, `/api/web/videos/jobs/${job.id}`), apiJson<VideoCapabilities>(user, '/api/web/videos/capabilities')])).then(([value, refreshed]) => { if (id === generation.current) { setJob(value); setCaps(refreshed) } }).catch(() => { if (id === generation.current) setError('Capture confirmation is pending. Reload to check; do not pay again.') }).finally(release)
        } })
        checkout.open()
        modalOpen = true
      }
    } catch (e) { if (id === generation.current) setError(e instanceof Error ? e.message : 'Admission failed'); void refreshCapabilities() }
    finally { if (!modalOpen && id === generation.current) { setBusy(false); submitting.current = false } }
  }
  const required = swap === 'both' ? ['male', 'female'] : [swap]
  const allConsent = Object.values(consent).every(Boolean)
  const paidAvailable = !!caps && (caps.paid_available ?? (caps.paid_enabled && caps.available))
  const checkoutExpired = job?.state === 'checkout' && !!job.checkout_expires_at && Date.parse(job.checkout_expires_at) <= Date.now()
  const canStartNew = !!job && (['expired', 'failed', 'cancelled', 'refunded', 'refund_pending', 'ready'].includes(job.state) || checkoutExpired)
  const removePhoto = (role: string) => {
    const old = previewUrls.current[role]
    if (old) URL.revokeObjectURL(old)
    delete previewUrls.current[role]
    if (inputRefs.current[role]) inputRefs.current[role]!.value = ''
    setPhotos(previous => { const next = { ...previous }; delete next[role]; return next })
    setPreviews(previous => { const next = { ...previous }; delete next[role]; return next })
    setError('')
  }
  return <main className="videos-page"><Link to="/">← Back to chat</Link><h1>Create video</h1>
    <p>Put consenting adult faces into a reviewed short template. This is face replacement, not text-to-video. Processing is asynchronous.</p>
    {error && <p role="alert">{error}</p>}
    {!caps ? <p>Checking account eligibility…</p> : <>
      {!caps.available && <p role="status">Video creation is paused. Existing results and refund status remain available.</p>}
      <div className="video-gallery">{caps.templates.map(item => <button key={item.id} disabled={!item.available || !!job} aria-pressed={template === item.id} onClick={() => setTemplate(item.id)}><Film aria-hidden="true" /><strong>{item.title}</strong><span>{item.available ? 'Reviewed template' : 'Awaiting operator media and approval'}</span></button>)}</div>
      <form onSubmit={e => { e.preventDefault(); void validate() }}>
        <fieldset disabled={busy || !!job || !caps.available}><legend>Choose the role to replace</legend>
          <label>Swap <select value={swap} onChange={e => { const value = e.target.value as 'both' | 'male' | 'female'; setSwap(value); setInstructionText(formatSupportedInstructions({ swap: value, enhance: enhance as 'off' | 'natural', caption })) }}><option value="both">Both roles</option><option value="male">Male role</option><option value="female">Female role</option></select></label>
          {required.map(role => <label key={role}>{role === 'male' ? 'Male role photo' : 'Female role photo'}<input ref={node => { inputRefs.current[role] = node }} type="file" accept="image/jpeg,image/png,image/webp" required onChange={e => {
            const file = e.target.files?.[0]
            const old = previewUrls.current[role]
            if (old) URL.revokeObjectURL(old)
            delete previewUrls.current[role]
            if (!file || file.size === 0 || file.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
              setPhotos(previous => { const next = { ...previous }; delete next[role]; return next })
              setPreviews(previous => { const next = { ...previous }; delete next[role]; return next })
              setError('Choose a non-empty JPEG, PNG or WebP photo no larger than 5 MiB.')
              return
            }
            setPhotos(previous => ({ ...previous, [role]: file }))
            if (typeof URL.createObjectURL === 'function') { const preview = URL.createObjectURL(file); previewUrls.current[role] = preview; setPreviews(previous => ({ ...previous, [role]: preview })) }
            setError('')
          }} />{previews[role] && <><img src={previews[role]} alt={`${role} role preview`} className="video-photo-preview" /><button type="button" onClick={() => removePhoto(role)}>Remove {role} photo</button></>}</label>)}
          <label>Enhancement <select value={enhance} onChange={e => { const value = e.target.value as 'off' | 'natural'; setEnhance(value); setInstructionText(formatSupportedInstructions({ swap: swap as 'both' | 'male' | 'female', enhance: value, caption })) }}><option value="off">Off</option><option value="natural">Conservative natural</option></select></label>
          <label>Caption (optional; printable ASCII)<input maxLength={100} value={caption} onChange={e => { setCaption(e.target.value); setInstructionText(formatSupportedInstructions({ swap: swap as 'both' | 'male' | 'female', enhance: enhance as 'off' | 'natural', caption: e.target.value })) }} /></label>
          <label>Supported edit instructions <textarea aria-label="Supported edit instructions" aria-describedby="video-instructions-help" value={instructionText} onChange={e => {
            const value = e.target.value
            setInstructionText(value)
            const parsed = parseSupportedInstructions(value)
            if (parsed) { setSwap(parsed.swap); setEnhance(parsed.enhance); setCaption(parsed.caption) }
          }} rows={4} />
            <span id="video-instructions-help">Use only <code>swap: both|male|female</code>, <code>enhance: off|natural</code>, and optional printable-ASCII <code>caption:</code>. This does not create new scenes, actions or speech.</span>
          </label>
          <p>One clear face per photo. Metadata is stripped. No background identity, clothing, location, action or speech changes. Photos relay privately to the Mac and are deleted on completion, or within four hours of admission. Unpaid uploads expire after ten minutes. Results expire ten minutes after ready.</p>
          <fieldset className="video-consent"><legend>Required confirmations</legend>
            <label><input type="checkbox" checked={consent.requesterAdult} onChange={e => setConsent(previous => ({ ...previous, requesterAdult: e.target.checked }))} />I am at least 18 years old and authorised to submit this request.</label>
            <label><input type="checkbox" checked={consent.sourceFacesAdult} onChange={e => setConsent(previous => ({ ...previous, sourceFacesAdult: e.target.checked }))} />Every person depicted by a supplied source face is an adult.</label>
            <label><input type="checkbox" checked={consent.sourceFacePermission} onChange={e => setConsent(previous => ({ ...previous, sourceFacePermission: e.target.checked }))} />Each depicted person gave permission for this specific face edit, or I hold clear specific authority to act for them.</label>
            <label><input type="checkbox" checked={consent.sourcePhotoRights} onChange={e => setConsent(previous => ({ ...previous, sourcePhotoRights: e.target.checked }))} />I have the right to upload and use every source photo, including any applicable copyright, privacy and publicity permissions.</label>
            <label><input type="checkbox" checked={consent.syntheticMedia} onChange={e => setConsent(previous => ({ ...previous, syntheticMedia: e.target.checked }))} />I understand the output is synthetic/AI-edited media, will carry a visible disclosure and provenance metadata, and must not be presented as authentic evidence.</label>
            <label><input type="checkbox" checked={consent.prohibitedUse} onChange={e => setConsent(previous => ({ ...previous, prohibitedUse: e.target.checked }))} />I will not use this for minors, sexual abuse or exploitation, non-consensual intimate imagery, deceptive impersonation, fraud, false records, harassment or unlawful harm. I accept the <a href="/legal/ai">acceptable-use policy</a>.</label>
            <label><input type="checkbox" checked={consent.retention} onChange={e => setConsent(previous => ({ ...previous, retention: e.target.checked }))} />I understand source uploads are temporary, are deleted under the published retention rules and are not a reusable face library.</label>
            <label><input type="checkbox" checked={consent.disclosure} onChange={e => setConsent(previous => ({ ...previous, disclosure: e.target.checked }))} />I will not remove or obscure the disclosure or provenance identifier from a generated output.</label>
          </fieldset>
          <button type="submit" disabled={!allConsent || !parseSupportedInstructions(instructionText) || required.some(role => !photos[role])}>Validate photos on Mac (no charge)</button>
        </fieldset>
      </form>
      {job?.state === 'checkout' && <section><h2>{checkoutExpired ? 'Checkout expired' : 'Resume payment'}</h2><p>{checkoutExpired ? 'This payment hold expired without creating another order. Close it before starting a fresh request.' : 'Your existing ₹25 checkout was created for this request. Reopening this button reuses the same order; it does not create another charge.'}</p>{job.checkout_expires_at && <p>Checkout hold expires {new Date(job.checkout_expires_at).toLocaleString()}.</p>}<button disabled={busy} onClick={() => { void admit('paid') }}>{checkoutExpired ? 'Close expired checkout' : 'Resume payment'}</button></section>}
      {job?.state === 'validated' && <section><h2>Confirm supported edit</h2><p>{editSummary(job.options)}</p><p>Only this supported face-replacement edit will be run. Payment/allowance is only reserved after you confirm. Queue time depends on measured Mac performance.</p>
        <p>{caps.allowance.unlimited ? 'Unlimited complimentary allowance (capacity limits apply)' : `${caps.allowance.remaining} complimentary attempts remain. Reset ${new Date(caps.allowance.reset_at).toLocaleString()}.`}</p>
        <button disabled={busy || !caps.available || !(caps.allowance.unlimited || caps.allowance.remaining)} onClick={() => { void admit('complimentary') }}>Use complimentary attempt</button>
        {caps.paid_enabled && !paidAvailable && <p role="status">Paid video checkout is configured but currently unavailable because the verified worker, legal or template gates are closed.</p>}
        <button disabled={busy || !paidAvailable} onClick={() => { void admit('paid') }}>Pay ₹25 total for this video</button></section>}
    </>}
    {job && <VideoCard key={job.id} jobId={job.id} initialJob={job} onJobChange={onJobChange} />}
    {canStartNew && <button onClick={() => { setJobs(previous => [job!, ...previous.filter(item => item.id !== job!.id)]); setJob(null); setPhotos({}); clearPreviews(); setConsent(emptyConsent); setInstructionText(DEFAULT_INSTRUCTIONS); setSwap('both'); setEnhance('off'); setCaption(''); setError(''); requestKey.current = crypto.randomUUID(); void refreshCapabilities() }}>Start a new request with fresh consent</button>}
    <h2>Your video history</h2>{jobs.filter(item => item.id !== job?.id).map(item => <VideoCard jobId={item.id} initialJob={item} key={item.id} />)}
  </main>
}
