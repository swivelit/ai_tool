import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/useAuth'
import { API_BASE, apiJson } from '../api/client'
import type { VideoJob } from './types'

export function VideoCard({ jobId }: { jobId: string }) {
  const { user } = useAuth()
  const [job, setJob] = useState<VideoJob | null>(null)
  const [error, setError] = useState('')
  const [url, setUrl] = useState('')
  const blobRef = useRef('')
  const epoch = useRef(0)
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const epochId = ++epoch.current
    setJob(null); setError(''); setUrl(''); setExpired(false)
    if (!user) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const value = await apiJson<VideoJob>(user, `/api/web/videos/jobs/${jobId}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        setJob(value)
        if (value.state === 'expired' || value.expires_at && Date.parse(value.expires_at) <= Date.now()) setExpired(true)
        else timer = setTimeout(() => { void poll() }, 3000)
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Video unavailable') }
    }
    void poll()
    return () => { epoch.current = epochId + 1; controller.abort(); clearTimeout(timer); if (blobRef.current) URL.revokeObjectURL(blobRef.current); blobRef.current = '' }
  }, [user, jobId])
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
      if (requestEpoch === epoch.current) setJob(value)
    } catch (e) { if (requestEpoch === epoch.current) setError(String(e)) }
  }
  return <article className="video-card" aria-label="AI-edited video">
    <h3>Swico · AI-edited video</h3>
    {error && <p role="alert">{error}</p>}
    {!job ? <p>Loading video status…</p> : <>
      <p>{expired ? 'Expired — the temporary video is no longer available.' : `${job.state} · ${job.phase}`}</p>
      {!expired && job.state === 'processing' && <progress max={100} value={job.progress}>{job.progress}%</progress>}
      {job.queue_position && <p>Queue position {job.queue_position}. {job.paused ? 'Worker offline; queue paused.' : job.eta_seconds ? `Estimated ${Math.ceil(job.eta_seconds[0] / 60)}–${Math.ceil(job.eta_seconds[1] / 60)} minutes; not a guarantee.` : 'Calibrating estimate.'}</p>}
      {job.error && <p>{job.error.replaceAll('_', ' ')}</p>}
      {job.refund_status && <p>Refund: {job.refund_status.replaceAll('_', ' ')}. A request is not confirmation of a processed refund.</p>}
      {job.notification_status && <p>Email notification: {job.notification_status.replaceAll('_', ' ')}. Email delivery does not extend the download window.</p>}
      {!expired && job.state === 'ready' && <>
        <p>Download before {new Date(job.expires_at!).toLocaleString()}. Downloads you save cannot be revoked.</p>
        {!url ? <button onClick={() => { void load() }}>Load private video</button> : <><video controls src={url} aria-label="Your generated video" /><a href={url} download={`swico-${job.id}.mp4`}>Download MP4</a></>}
      </>}
      {!['ready', 'expired', 'failed', 'cancelled', 'refunded', 'refund_pending'].includes(job.state) && <button onClick={() => { void cancel() }}>Cancel request</button>}
      <a href="/videos">Create another video (new consent and admission required)</a>
    </>}
  </article>
}
