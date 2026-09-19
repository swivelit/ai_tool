import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/useAuth'
import { API_BASE, apiJson } from '../api/client'
import type { VideoJob } from './types'

const SETTLED = new Set(['ready', 'expired', 'failed', 'cancelled', 'refund_pending', 'refunded'])

type Props = { jobId: string; initialJob?: VideoJob | null; onJobChange?: (job: VideoJob) => void }

function statusText(job: VideoJob, expired: boolean) {
  if (expired) return 'Expired — the temporary video is no longer available.'
  if (job.state === 'checkout') return 'Payment confirmation is pending.'
  if (job.state === 'queued') return 'Waiting for the private video worker.'
  if (job.state === 'processing') return job.phase === 'validation' ? 'Checking the uploaded photos.' : 'Rendering your video.'
  if (job.state === 'ready') return 'Your video is ready.'
  if (job.state === 'cancelled') return 'This request was cancelled.'
  if (job.state === 'refunded' || job.state === 'refund_pending') return 'This request is in refund recovery.'
  if (job.state === 'failed') return 'This request could not be completed.'
  return 'Checking your video request.'
}

export function VideoCard({ jobId, initialJob = null, onJobChange }: Props) {
  const { user } = useAuth()
  const [job, setJob] = useState<VideoJob | null>(initialJob)
  const [error, setError] = useState('')
  const [url, setUrl] = useState('')
  const blobRef = useRef('')
  const epoch = useRef(0)
  const initialJobRef = useRef(initialJob)
  const [expired, setExpired] = useState(false)

  const accept = useCallback((value: VideoJob, currentEpoch: number) => {
    if (currentEpoch !== epoch.current) return
    setJob(value)
    onJobChange?.(value)
    setExpired(value.state === 'expired' || !!value.expires_at && Date.parse(value.expires_at) <= Date.now())
  }, [onJobChange])

  useEffect(() => {
    const currentEpoch = ++epoch.current
    setJob(initialJobRef.current ?? null); setError(''); setUrl(''); setExpired(false)
    if (!user) return
    const controller = new AbortController()
    let delay = 2500
    let settlementPolls = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    let refreshQueued = false
    const schedule = (wait: number) => {
      clearTimeout(retryTimer)
      retryTimer = setTimeout(() => { void poll() }, wait)
    }
    const poll = async () => {
      if (inFlight) { refreshQueued = true; return }
      inFlight = true
      try {
        const value = await apiJson<VideoJob>(user, `/api/web/videos/jobs/${jobId}`, { signal: controller.signal })
        if (controller.signal.aborted || currentEpoch !== epoch.current) return
        accept(value, currentEpoch)
        setError('')
        delay = 2500
        const notificationPending = value.state === 'ready' && !!value.notification_status && !['sent', 'suppressed', 'expired', 'failed'].includes(value.notification_status)
        const refundPending = value.state === 'refund_pending' || !!value.refund_status && ['pending', 'submitted', 'ambiguous'].includes(value.refund_status)
        const stillActive = !SETTLED.has(value.state) || notificationPending || refundPending
        if (stillActive && (settlementPolls < 20 || !SETTLED.has(value.state))) {
          if (notificationPending || refundPending) settlementPolls += 1
          schedule(delay)
        }
      } catch {
        if (controller.signal.aborted) return
        setError('Video status could not be refreshed. Retrying…')
        delay = Math.min(30000, Math.round(delay * 1.8))
        schedule(delay + Math.floor(Math.random() * 250))
      } finally {
        inFlight = false
        if (refreshQueued && !controller.signal.aborted) {
          refreshQueued = false
          void poll()
        }
      }
    }
    const recover = () => {
      if (navigator.onLine && document.visibilityState === 'visible') { clearTimeout(retryTimer); void poll() }
    }
    window.addEventListener('online', recover)
    window.addEventListener('focus', recover)
    void poll()
    return () => {
      epoch.current = currentEpoch + 1
      controller.abort(); clearTimeout(retryTimer)
      window.removeEventListener('online', recover); window.removeEventListener('focus', recover)
      if (blobRef.current) URL.revokeObjectURL(blobRef.current)
      blobRef.current = ''
    }
  }, [accept, jobId, user])

  useEffect(() => {
    if (!job?.expires_at) return
    const timer = setTimeout(() => { setExpired(true); setUrl(''); if (blobRef.current) URL.revokeObjectURL(blobRef.current); blobRef.current = '' }, Math.max(0, Date.parse(job.expires_at) - Date.now()))
    return () => clearTimeout(timer)
  }, [job?.expires_at])

  const load = async () => {
    if (!user || !job || expired) return
    const requestEpoch = epoch.current
    try {
      const token = await user.getIdToken()
      const response = await fetch(`${API_BASE}/api/web/videos/jobs/${jobId}/media`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      if (!response.ok) throw new Error(response.status === 410 ? 'Video expired' : 'Video unavailable; check recovery/refund status')
      const blob = await response.blob()
      if (blob.size > 16777216 || !job.expires_at || Date.parse(job.expires_at) <= Date.now() || requestEpoch !== epoch.current) return
      if (blobRef.current) URL.revokeObjectURL(blobRef.current)
      blobRef.current = URL.createObjectURL(blob); setUrl(blobRef.current)
    } catch (e) { if (requestEpoch === epoch.current) setError(e instanceof Error ? e.message : 'Video unavailable') }
  }

  const cancel = async () => {
    if (!user) return
    const requestEpoch = epoch.current
    try {
      const value = await apiJson<VideoJob>(user, `/api/web/videos/jobs/${jobId}/cancel`, { method: 'POST' })
      accept(value, requestEpoch)
    } catch { if (requestEpoch === epoch.current) setError('Cancellation could not be confirmed; retrying status refresh.') }
  }

  return <article className="video-card" aria-label="AI-edited video">
    <h3>Swico · AI-edited video</h3>
    {error && <p role="alert">{error}</p>}
    {!job ? <p>Loading video status…</p> : <>
      <p>{statusText(job, expired)}</p>
      {job.provenance_id && <p>AI-edited / synthetic media · provenance {job.provenance_id}</p>}
      {!expired && job.state === 'processing' && <progress max={100} value={job.progress}>{job.progress}%</progress>}
      {job.eta_seconds && !expired && <p>{job.paused ? 'Worker temporarily offline; your accepted request is waiting.' : `Estimated ${Math.ceil(job.eta_seconds[0] / 60)}–${Math.ceil(job.eta_seconds[1] / 60)} minutes; not a guarantee.`}</p>}
      {job.queue_position && !expired && <p>Queue position {job.queue_position}.</p>}
      {job.error && <p>{job.error.replaceAll('_', ' ')}</p>}
      {job.refund_status && <p>Refund: {job.refund_status.replaceAll('_', ' ')}. A request is not confirmation of a processed refund.</p>}
      {job.notification_status && <p>Email notification: {job.notification_status.replaceAll('_', ' ')}. Email delivery does not extend the download window.</p>}
      {!expired && job.state === 'ready' && <>
        <p>Download before {new Date(job.expires_at!).toLocaleString()}. Downloads you save cannot be revoked.</p>
        {!url ? <button onClick={() => { void load() }}>Load private video</button> : <><video controls src={url} aria-label="Your generated video" /><a href={url} download={`swico-${job.id}.mp4`}>Download MP4</a></>}
      </>}
      {!SETTLED.has(job.state) && <button onClick={() => { void cancel() }}>Cancel request</button>}
      <a href="/videos">Create another video (new consent and admission required)</a>
    </>}
  </article>
}
