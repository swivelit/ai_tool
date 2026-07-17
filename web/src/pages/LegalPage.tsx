import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import legalContent from '../content/legalContent.json'

type LegalPageContent = (typeof legalContent.pages)[keyof typeof legalContent.pages]

export function LegalPage() {
  const { page } = useParams()
  const content = (page && page in legalContent.pages ? legalContent.pages[page as keyof typeof legalContent.pages] : null) as LegalPageContent | null
  if (!content) return <main className="legal-page"><Link to="/"><ArrowLeft size={16} /> Back to Swico</Link><div className="legal-heading"><span>Swico</span><h1>Policy not found</h1></div></main>
  const published = legalContent.publication.publicationStatus === 'approved'
  return <main className="legal-page"><Link to="/"><ArrowLeft size={16} /> Back to Swico</Link><div className="legal-heading"><span>Swico</span><h1>{content.title}</h1><p>{content.summary}</p><small>Version {content.version} · Effective date: {content.effectiveDate || 'Not published'}</small></div>
    {!published && <aside className="legal-warning"><strong>Policy text is not published</strong><p>This page is a publication framework, not final legal policy. Razorpay Live Mode remains blocked until counsel-approved, jurisdiction-appropriate text and publication metadata are supplied.</p></aside>}
    <div className="legal-sections">{content.sections.map((section, index) => <section key={section.heading}><span>{String(index + 1).padStart(2, '0')}</span><div><h2>{section.heading}</h2><p>{section.body || 'Reviewed publication text has not been supplied.'}</p></div></section>)}</div>
  </main>
}
