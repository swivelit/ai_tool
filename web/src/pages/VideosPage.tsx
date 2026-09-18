import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Film } from 'lucide-react'
import { useAuth } from '../auth/useAuth'
import { apiJson } from '../api/client'
import { loadRazorpay } from '../billing/razorpay'
import { VideoCard } from '../video/VideoCard'
import type { VideoCapabilities, VideoJob } from '../video/types'
import '../video/video.css'

type Checkout = { key_id: string; amount: number; currency: string; provider_order_id: string; internal_order_id: string }
export function VideosPage() {
  const { user } = useAuth()
  const [caps, setCaps] = useState<VideoCapabilities | null>(null)
  const [template, setTemplate] = useState('couple-01')
  const [swap, setSwap] = useState('both')
  const [enhance, setEnhance] = useState('off')
  const [caption, setCaption] = useState('')
  const [photos, setPhotos] = useState<Record<string, File>>({})
  const [consent, setConsent] = useState(false)
  const [job, setJob] = useState<VideoJob | null>(null)
  const [jobs, setJobs] = useState<VideoJob[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const submitting = useRef(false)
  const requestKey = useRef(crypto.randomUUID())
  useEffect(() => {
    const id = ++generation.current
    setJob(null); setJobs([]); setCaps(null); setPhotos({}); setConsent(false); setError(''); setBusy(false)
    submitting.current = false; requestKey.current = crypto.randomUUID()
    if (!user) return
    const controller = new AbortController()
    void Promise.all([apiJson<VideoCapabilities>(user, '/api/web/videos/capabilities', { signal: controller.signal }), apiJson<{ items: VideoJob[] }>(user, '/api/web/videos/jobs', { signal: controller.signal })]).then(([cap, list]) => { if (id === generation.current) {
      setCaps(cap); setJobs(list.items)
      setJob(list.items.find(item => !['ready', 'expired', 'failed', 'cancelled', 'refunded', 'refund_pending'].includes(item.state)) ?? null)
    } }).catch(e => { if (!controller.signal.aborted) setError(String(e)) })
    return () => { generation.current = id + 1; controller.abort() }
  }, [user])
  useEffect(() => {
    if (!user || !job || ['expired', 'failed', 'cancelled', 'refunded', 'refund_pending'].includes(job.state)) return
    const controller = new AbortController()
    const id = generation.current
    const timer = setTimeout(() => {
      void apiJson<VideoJob>(user, `/api/web/videos/jobs/${job.id}`, { signal: controller.signal }).then(value => { if (id === generation.current) setJob(value) }).catch(e => { if (!controller.signal.aborted) setError(String(e)) })
    }, 2500)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [user, job])
  const validate = async () => {
    if (!user || !caps || submitting.current) return
    submitting.current = true
    setBusy(true); setError('')
    const id = generation.current
    try {
      const result = await apiJson<VideoJob>(user, '/api/web/videos/jobs', { method: 'POST', body: JSON.stringify({ template_id: template, request_key: requestKey.current, instructions: `swap: ${swap}\nenhance: ${enhance}\ncaption: ${caption}`, consent, adult: consent, policy_version: caps.policy_version }) })
      if (id !== generation.current) return
      // Even an interrupted upload remains visible/cancellable; no hidden outstanding job.
      setJob(result)
      for (const role of swap === 'both' ? ['male', 'female'] : [swap]) {
        if (id !== generation.current) return
        if (!photos[role]) throw new Error(`Choose a ${role} role photo`)
        await apiJson(user, `/api/web/videos/jobs/${result.id}/photos/${role}`, { method: 'PUT', body: photos[role], headers: { 'Content-Type': 'application/octet-stream' } })
      }
      const validated = await apiJson<VideoJob>(user, `/api/web/videos/jobs/${result.id}/preflight`, { method: 'POST' })
      if (id === generation.current) { setJob(validated); setPhotos({}) }
    } catch (e) { if (id === generation.current) setError(e instanceof Error ? e.message : 'Validation failed') }
    finally { if (id === generation.current) { setBusy(false); submitting.current = false } }
  }
  const admit = async (funding: string) => {
    if (!user || !job || submitting.current) return
    submitting.current = true
    setBusy(true); setError(''); const id = generation.current
    try {
      const result = await apiJson<{ job: VideoJob; checkout: Checkout | null }>(user, `/api/web/videos/jobs/${job.id}/admit`, { method: 'POST', body: JSON.stringify({ funding }) })
      if (id !== generation.current) return
      setJob(result.job)
      if (result.checkout) {
        await loadRazorpay()
        if (id !== generation.current || !window.Razorpay) return
        const order = result.checkout
        const checkout = new window.Razorpay({ key: order.key_id, amount: order.amount, currency: order.currency, order_id: order.provider_order_id, name: 'Swico', description: 'One template video · ₹25 total · no wallet credits', modal: { ondismiss: () => { if (id === generation.current) setBusy(false) } }, handler: payment => {
          void apiJson(user, '/api/web/billing/verify', { method: 'POST', body: JSON.stringify({ ...payment, internal_order_id: order.internal_order_id }) }).catch(() => { if (id === generation.current) setError('Capture confirmation pending. Reload to check; do not pay again.') }).finally(() => { if (id === generation.current) setBusy(false) })
        } })
        checkout.open()
      }
    } catch (e) { if (id === generation.current) setError(e instanceof Error ? e.message : 'Admission failed') }
    finally { if (id === generation.current) { setBusy(false); submitting.current = false } }
  }
  const required = swap === 'both' ? ['male', 'female'] : [swap]
  return <main className="videos-page"><Link to="/">← Back to chat</Link><h1>Create video</h1>
    <p>Put consenting adult faces into a reviewed short template. This is face replacement, not text-to-video. Processing is asynchronous.</p>
    {error && <p role="alert">{error}</p>}
    {!caps ? <p>Checking account eligibility…</p> : <>
      {!caps.available && <p role="status">Video creation is paused. Existing results and refund status remain available.</p>}
      <div className="video-gallery">{caps.templates.map(item => <button key={item.id} disabled={!item.available || !!job} aria-pressed={template === item.id} onClick={() => setTemplate(item.id)}><Film aria-hidden="true" /><strong>{item.title}</strong><span>{item.available ? 'Reviewed template' : 'Awaiting operator media and approval'}</span></button>)}</div>
      <form onSubmit={e => { e.preventDefault(); void validate() }}>
        <fieldset disabled={busy || !!job || !caps.available}><legend>Choose the role to replace</legend>
          <label>Swap <select value={swap} onChange={e => setSwap(e.target.value)}><option value="both">Both roles</option><option value="male">Male role</option><option value="female">Female role</option></select></label>
          {required.map(role => <label key={role}>{role === 'male' ? 'Male role photo' : 'Female role photo'}<input type="file" accept="image/jpeg,image/png,image/webp" required onChange={e => { const file = e.target.files?.[0]; if (file && file.size <= 5 * 1024 * 1024) setPhotos(previous => ({ ...previous, [role]: file })); else setError('Each photo must be at most 5 MiB') }} /></label>)}
          <label>Enhancement <select value={enhance} onChange={e => setEnhance(e.target.value)}><option value="off">Off</option><option value="natural">Conservative natural</option></select></label>
          <label>Caption (optional; initial profile supports printable ASCII)<input maxLength={100} value={caption} onChange={e => setCaption(e.target.value)} /></label>
          <p>One clear face per photo. Metadata is stripped. No background identity, clothing, location, action or speech changes. Photos relay privately to the Mac and are deleted on completion, or within four hours of admission. Unpaid uploads expire after ten minutes. Results expire ten minutes after ready.</p>
          <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} required />All depicted source people are adults and consent to this edit. I have rights to use these photos and accept the <a href="/legal/ai">acceptable-use policy</a> ({caps.policy_version}). No sexual, deceptive or abusive impersonation.</label>
          <button type="submit" disabled={!consent || required.some(role => !photos[role])}>Validate photos on Mac (no charge)</button>
        </fieldset>
      </form>
      {job?.state === 'validated' && <section><h2>Confirm supported edit</h2><pre>{JSON.stringify(job.options, null, 2)}</pre><p>Payment/allowance is only reserved after you confirm. Queue time depends on measured Mac performance.</p>
        <p>{caps.allowance.unlimited ? 'Unlimited complimentary allowance (capacity limits apply)' : `${caps.allowance.remaining} complimentary attempts remain. Reset ${new Date(caps.allowance.reset_at).toLocaleString()}.`}</p>
        <button disabled={busy || !(caps.allowance.unlimited || caps.allowance.remaining)} onClick={() => { void admit('complimentary') }}>Use complimentary attempt</button>
        <button disabled={busy || !caps.paid_enabled} onClick={() => { void admit('paid') }}>Pay ₹25 total for this video</button></section>}
    </>}
    {job && <VideoCard key={job.id} jobId={job.id} />}
    {job && ['expired', 'failed', 'cancelled', 'refunded', 'refund_pending', 'ready'].includes(job.state) && <button onClick={() => { setJobs(previous => [job, ...previous.filter(item => item.id !== job.id)]); setJob(null); setPhotos({}); setConsent(false); setError(''); requestKey.current = crypto.randomUUID() }}>Start a new request with fresh consent</button>}
    <h2>Your video history</h2>{jobs.filter(item => item.id !== job?.id).map(item => <VideoCard jobId={item.id} key={item.id} />)}
  </main>
}
