import { useEffect, useState } from 'react'
import type { User } from 'firebase/auth'
import {
  ApiError,
  approveKnowledgeDocument,
  cancelKnowledgeJob,
  deleteKnowledgeDocument,
  listKnowledgeDocuments,
  reindexKnowledgeDocument,
} from '../api/client'
import type { KnowledgeDocument, ReadyAttachment } from '../types'

const statusLabel: Record<KnowledgeDocument['status'], string> = {
  pending: 'Pending',
  indexing: 'Indexing',
  ready: 'Ready',
  failed: 'Failed',
  invalidated: 'Invalidated',
}

function safeKnowledgeError(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return 'The temporary document expired or is no longer available.'
  }
  return 'The Knowledge Library request could not be completed. Try again.'
}

export function KnowledgeLibrary({
  user,
  uploads,
}: {
  user: User
  uploads: ReadyAttachment[]
}) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [selectedUploadId, setSelectedUploadId] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = async () => {
    const next = await listKnowledgeDocuments(user)
    setDocuments(next)
  }

  useEffect(() => {
    setDocuments([])
    setSelectedUploadId('')
    setConfirmed(false)
    setNotice('')
    void refresh().catch(error => setNotice(safeKnowledgeError(error)))
  }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!documents.some(item => item.status === 'pending' || item.status === 'indexing')) {
      return
    }
    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined)
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [documents, user]) // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async () => {
    if (!selectedUploadId || !confirmed) return
    setBusy('approve')
    setNotice('')
    try {
      const result = await approveKnowledgeDocument(user, selectedUploadId)
      setDocuments(value => [
        result.document,
        ...value.filter(item => item.id !== result.document.id),
      ])
      setSelectedUploadId('')
      setConfirmed(false)
      setNotice('Document saved. Indexing has started.')
    } catch (error) {
      setNotice(safeKnowledgeError(error))
    } finally {
      setBusy('')
    }
  }

  const remove = async (document: KnowledgeDocument) => {
    if (!window.confirm(`Remove “${document.title}” from your Knowledge Library?`)) return
    setBusy(document.id)
    setNotice('')
    try {
      await deleteKnowledgeDocument(user, document.id)
      setDocuments(value => value.filter(item => item.id !== document.id))
      setNotice('Document removed from your Knowledge Library.')
    } catch (error) {
      setNotice(safeKnowledgeError(error))
    } finally {
      setBusy('')
    }
  }

  const reindex = async (document: KnowledgeDocument) => {
    setBusy(document.id)
    setNotice('')
    try {
      const result = await reindexKnowledgeDocument(user, document.id)
      setDocuments(value => value.map(item => (
        item.id === document.id ? result.document : item
      )))
      setNotice('Re-indexing has started.')
    } catch (error) {
      setNotice(safeKnowledgeError(error))
    } finally {
      setBusy('')
    }
  }

  const cancelIndexing = async (document: KnowledgeDocument) => {
    setBusy(document.id)
    setNotice('')
    try {
      await cancelKnowledgeJob(user, document.id)
      setDocuments(value => value.map(item => (
        item.id === document.id
          ? { ...item, status: 'failed' as const }
          : item
      )))
      setNotice('Indexing cancelled.')
    } catch (error) {
      setNotice(safeKnowledgeError(error))
    } finally {
      setBusy('')
    }
  }

  return <section className="knowledge-library" aria-labelledby="knowledge-library-title">
    <h3 id="knowledge-library-title">Knowledge Library</h3>
    <p>Saved documents remain in your Knowledge Library until you remove them.</p>
    <div className="knowledge-approval">
      <label htmlFor="knowledge-upload">Uploaded document
        <select
          id="knowledge-upload"
          value={selectedUploadId}
          disabled={busy !== ''}
          onChange={event => {
            setSelectedUploadId(event.target.value)
            setConfirmed(false)
          }}
        >
          <option value="">Select a temporary upload</option>
          {uploads.map(upload => <option key={upload.id} value={upload.id}>{upload.name}</option>)}
        </select>
      </label>
      {!uploads.length && <small>Upload a document in chat first, then return here before it expires.</small>}
      <label className="check-row">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={!selectedUploadId || busy !== ''}
          onChange={event => setConfirmed(event.target.checked)}
        />
        Save to my Knowledge Library
      </label>
      <button
        type="button"
        className="primary"
        disabled={!selectedUploadId || !confirmed || busy !== ''}
        onClick={() => void approve()}
      >
        {busy === 'approve' ? 'Saving…' : 'Save document'}
      </button>
    </div>

    <div className="knowledge-list" aria-label="Saved knowledge documents">
      {!documents.length
        ? <p>No saved documents yet.</p>
        : documents.map(document => <article key={document.id}>
          <span>
            <strong>{document.title}</strong>
            <small>{statusLabel[document.status]} · {document.chunk_count.toLocaleString()} sections</small>
          </span>
          <div>
            {(document.status === 'pending' || document.status === 'indexing') && <button
              type="button"
              disabled={busy !== ''}
              onClick={() => void cancelIndexing(document)}
            >
              Cancel indexing
            </button>}
            <button
              type="button"
              disabled={
                busy !== ''
                || document.status === 'indexing'
                || document.status === 'pending'
                || document.status === 'invalidated'
              }
              onClick={() => void reindex(document)}
            >
              Re-index
            </button>
            <button
              type="button"
              disabled={busy !== ''}
              onClick={() => void remove(document)}
            >
              Remove
            </button>
          </div>
        </article>)}
    </div>
    <div role="status" aria-live="polite">{notice}</div>
  </section>
}
