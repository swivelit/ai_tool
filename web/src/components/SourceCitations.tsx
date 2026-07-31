import { FileText } from 'lucide-react'
import type { SourceSummary } from '../types'

export function SourceCitations({ sources }: { sources: SourceSummary[] }) {
  if (!sources.length) return null
  return <section className="source-citations" aria-label="Sources">
    <strong>Sources</strong>
    <ol>
      {sources.map(source => <li key={`${source.id}-${source.locator}`}>
        <FileText size={14} aria-hidden="true" />
        <span><b>{source.id}</b> {source.label}<small>{source.locator}</small></span>
      </li>)}
    </ol>
  </section>
}
