import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { cancelCloudJob, createCloudJob, downloadCloudArtifact, getCloudJob, listCloudArtifacts, listCloudJobEvents, listCloudJobs, type CloudArtifact, type CloudJob, type CloudJobEvent } from '../api/client'
import { useAuth } from '../auth/useAuth'

const ACTIVE_STATUSES = new Set(['queued', 'dispatching', 'starting', 'running', 'waiting_for_approval', 'cancelling'])
function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError' }
function resultValue(result: Record<string, unknown> | undefined, key: string): unknown { return result && Object.prototype.hasOwnProperty.call(result, key) ? result[key] : undefined }

export function CloudTasksPage() {
  const { user } = useAuth()
  const [jobs, setJobs] = useState<CloudJob[]>([])
  const [selected, setSelected] = useState<CloudJob | null>(null)
  const [events, setEvents] = useState<CloudJobEvent[]>([])
  const [artifacts, setArtifacts] = useState<CloudArtifact[]>([])
  const [task, setTask] = useState('')
  const [consented, setConsented] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const eventCursor = useRef(-1)
  const selectedId = selected?.id ?? null
  const selectedIdRef = useRef<string | null>(null)
  const listGeneration = useRef(0)
  const selectionGeneration = useRef(0)
  const selectionController = useRef<AbortController | null>(null)
  const pendingCreate = useRef<{ requestId: string; task: string } | null>(null)

  const loadJobs = useCallback(async (signal?: AbortSignal) => {
    if (!user) return
    const generation = ++listGeneration.current
    try {
      const result = await listCloudJobs(user, signal)
      if (generation === listGeneration.current && !signal?.aborted) setJobs(result.items)
    } catch (value) {
      if (generation === listGeneration.current && !isAbort(value)) setError(value instanceof Error ? value.message : 'Cloud tasks are unavailable.')
    } finally {
      if (generation === listGeneration.current) setLoading(false)
    }
  }, [user])

  useEffect(() => {
    listGeneration.current += 1; selectionGeneration.current += 1
    selectionController.current?.abort(); selectionController.current = null
    selectedIdRef.current = null
    eventCursor.current = -1
    setJobs([]); setSelected(null); setEvents([]); setArtifacts([]); setError(''); setLoading(true); setConsented(false)
    if (!user) { setLoading(false); return }
    const controller = new AbortController()
    void loadJobs(controller.signal)
    return () => { controller.abort(); selectionController.current?.abort(); selectionController.current = null; listGeneration.current += 1; selectionGeneration.current += 1 }
  }, [user, loadJobs])

  const appendEvents = useCallback((jobId: string, incoming: CloudJobEvent[]) => {
    if (selectedIdRef.current !== jobId || !incoming.length) return
    setEvents(previous => {
      const seen = new Set(previous.map(item => `${jobId}:${item.sequence}`))
      const fresh = incoming.filter(item => !seen.has(`${jobId}:${item.sequence}`))
      return fresh.length ? [...previous, ...fresh].sort((a, b) => a.sequence - b.sequence) : previous
    })
    eventCursor.current = Math.max(eventCursor.current, ...incoming.map(item => item.sequence))
  }, [])

  useEffect(() => {
    if (!user || !selectedId || !ACTIVE_STATUSES.has(selected?.status ?? '')) return
    const controller = new AbortController()
    const generation = ++selectionGeneration.current
    const poll = async () => {
      try {
        const latest = await getCloudJob(user, selectedId, controller.signal)
        if (controller.signal.aborted || generation !== selectionGeneration.current || selectedIdRef.current !== latest.id) return
        setSelected(latest)
        const result = await listCloudJobEvents(user, latest.id, eventCursor.current, controller.signal)
        if (generation === selectionGeneration.current && result.job_id === selectedIdRef.current) appendEvents(result.job_id, result.items)
        if (generation === selectionGeneration.current) void loadJobs(controller.signal)
      } catch (value) {
        if (!isAbort(value) && !controller.signal.aborted && generation === selectionGeneration.current) setError(value instanceof Error ? value.message : 'Cloud task refresh failed.')
      }
    }
    const timer = window.setInterval(() => { void poll() }, 5_000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [user, selectedId, selected?.status, appendEvents, loadJobs])

  if (!user) return <main className="login-page"><section className="auth-card"><Link to="/login?returnTo=%2Ftasks">Sign in to view tasks</Link></section></main>

  const start = async () => {
    const trimmed = task.trim()
    if (!trimmed || !consented || starting) return
    setStarting(true); setError('')
    const existing = pendingCreate.current
    const request = existing?.task === trimmed ? existing : { requestId: crypto.randomUUID(), task: trimmed }
    pendingCreate.current = request
    try {
      const job = await createCloudJob(user, trimmed, request.requestId)
      pendingCreate.current = null
      selectedIdRef.current = job.id; eventCursor.current = -1; selectionGeneration.current += 1
      setTask(''); setConsented(false); setSelected(job); setEvents([]); setArtifacts([]); await loadJobs()
    } catch (value) {
      if (!isAbort(value)) setError(value instanceof Error ? value.message : 'Cloud tasks are unavailable.')
    } finally { setStarting(false) }
  }

  const select = async (job: CloudJob) => {
    const generation = ++selectionGeneration.current
    selectionController.current?.abort()
    selectedIdRef.current = job.id; eventCursor.current = -1
    setSelected(job); setEvents([]); setArtifacts([]); setError('')
    const controller = new AbortController(); selectionController.current = controller
    try {
      const result = await listCloudJobEvents(user, job.id, -1, controller.signal)
      if (generation !== selectionGeneration.current || selectedIdRef.current !== job.id || result.job_id !== job.id) return
      setEvents(result.items); eventCursor.current = result.items.at(-1)?.sequence ?? -1
      const stored = await listCloudArtifacts(user, job.id, controller.signal)
      if (generation === selectionGeneration.current && selectedIdRef.current === job.id) setArtifacts(stored.items)
    } catch (value) { if (!isAbort(value) && generation === selectionGeneration.current) setError(value instanceof Error ? value.message : 'Could not load task events.') }
    finally { if (selectionController.current === controller) selectionController.current = null }
  }

  const cancel = async () => {
    if (!selected || cancelling) return
    const jobId = selected.id
    setCancelling(true); setError('')
    try {
      const job = await cancelCloudJob(user, jobId)
      if (selectedIdRef.current === jobId) setSelected(job)
      await loadJobs()
    } catch (value) { setError(value instanceof Error ? value.message : 'Cancellation failed.') } finally { setCancelling(false) }
  }

  const download = async (artifact: CloudArtifact) => {
    if (downloading) return
    setDownloading(artifact.id); setError('')
    try {
      const blob = await downloadCloudArtifact(user, artifact.job_id, artifact.id)
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a')
      anchor.href = url; anchor.download = `swico-${artifact.kind}-${artifact.id}.bin`; anchor.click(); URL.revokeObjectURL(url)
    } catch (value) { setError(value instanceof Error ? value.message : 'Artifact download failed.') } finally { setDownloading(null) }
  }

  const result = selected?.result ?? {}
  const changedFiles = resultValue(result, 'changed_files')
  const tests = resultValue(result, 'tests')
  const patch = resultValue(result, 'patch')

  return <main className="login-page"><section className="auth-card" style={{ maxWidth: 960, width: 'calc(100% - 32px)' }}>
    <header><Link to="/">← Back to Swico</Link><h1>Cloud tasks</h1><p>Cloud coding runs require a separately verified isolated runner. Starting a task never merges or pushes repository changes.</p></header>
    <div style={{ display: 'grid', gap: 8, margin: '18px 0' }}>
      <label htmlFor="cloud-task">Task description</label><textarea id="cloud-task" value={task} onChange={event => { setTask(event.target.value); if (pendingCreate.current?.task !== event.target.value.trim()) pendingCreate.current = null }} placeholder="Describe a task for an isolated runner" maxLength={8000} rows={4} />
      <label><input type="checkbox" checked={consented} onChange={event => setConsented(event.target.checked)} /> I understand this sends the task to an isolated Cloud runner for processing.</label>
      <button type="button" onClick={() => void start()} disabled={!task.trim() || !consented || starting}>{starting ? 'Submitting…' : 'Start task'}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {loading ? <p>Loading tasks…</p> : jobs.length ? <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 0.8fr) minmax(320px, 1.2fr)', gap: 20 }}>
      <div aria-label="Cloud task list">{jobs.map(job => <button key={job.id} type="button" onClick={() => void select(job)} aria-pressed={selectedId === job.id} style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 8 }}><strong>{job.status}</strong><br /><small>{job.task.slice(0, 120)}</small></button>)}</div>
      {selected && <article aria-live="polite"><h2>{selected.status}</h2><p>{selected.task}</p><p>Created {new Date(selected.created_at).toLocaleString()}</p>{ACTIVE_STATUSES.has(selected.status) && <button type="button" onClick={() => void cancel()} disabled={cancelling}>{cancelling ? 'Cancelling…' : 'Cancel task'}</button>}{['failed', 'cancelled', 'expired'].includes(selected.status) && <button type="button" onClick={() => { setTask(selected.task); setConsented(false); setError('') }}>Retry as a new task</button>}<h3>Timeline</h3>{events.length ? <ol>{events.map(event => <li key={`${selected.id}:${event.sequence}`}>{event.event_type} · {new Date(event.created_at).toLocaleString()}</li>)}</ol> : <p>No events recorded.</p>}{selected.failure_code && <p role="alert">Task failed: {selected.failure_code}</p>}{Array.isArray(changedFiles) && <><h3>Changed files</h3><ul>{changedFiles.map(file => <li key={String(file)}>{String(file)}</li>)}</ul></>}{typeof tests === 'string' && <><h3>Tests</h3><pre>{tests}</pre></>}{typeof patch === 'string' && <><h3>Review diff</h3><pre style={{ overflowX: 'auto' }}>{patch}</pre></>}{artifacts.length > 0 && <><h3>Review artifacts</h3><ul>{artifacts.map(item => <li key={item.id}>{item.kind} · {item.size_bytes} bytes · {item.sha256.slice(0, 12)}… <button type="button" onClick={() => void download(item)} disabled={downloading !== null} aria-label={`Download ${item.kind} artifact`}>{downloading === item.id ? 'Downloading…' : 'Download'}</button></li>)}</ul></>}</article>}
    </div> : <p>No tasks yet. Starting a task requires the Cloud pilot to be enabled for this account.</p>}
  </section></main>
}
