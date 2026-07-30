import { Check, Copy, Pencil } from 'lucide-react'
import { useClipboardFeedback } from './useClipboardFeedback'

export function PromptToolbar({
  content,
  canEdit,
  editDisabled,
  onEdit,
}: {
  content: string
  canEdit: boolean
  editDisabled: boolean
  onEdit: () => void
}) {
  const { copy, copyState } = useClipboardFeedback(content)
  if (!content) return null

  const copyLabel = copyState === 'copied'
    ? 'Prompt copied'
    : copyState === 'failed' ? 'Copy failed' : 'Copy prompt'

  return <div className="user-message-actions" role="toolbar" aria-label="Prompt actions">
    <button type="button" aria-label={copyLabel} title={copyState === 'idle' ? 'Copy' : copyLabel} onClick={() => void copy()}>
      {copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
      {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
    {canEdit && <button type="button" aria-label="Edit message" title="Edit and regenerate" disabled={editDisabled} onClick={onEdit}>
      <Pencil size={14} /> Edit
    </button>}
    <span className="prompt-copy-status" role="status" aria-live="polite">
      {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : ''}
    </span>
  </div>
}
