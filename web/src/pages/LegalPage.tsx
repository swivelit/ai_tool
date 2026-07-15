import { Link, useParams } from 'react-router-dom'

export function LegalPage() {
  const { page } = useParams()
  const title: Record<string, string> = { terms: 'Terms', privacy: 'Privacy', refunds: 'Refund policy', ai: 'AI limitations', contact: 'Contact & support' }
  return <main className="legal-page"><Link to="/">← Back to Swico</Link><span className="eyebrow">Legal placeholder</span><h1>{title[page ?? ''] ?? 'Information'}</h1><div className="placeholder"><strong>Placeholder — publication content required.</strong><p>This page intentionally contains no invented legal language. Replace it with reviewed, jurisdiction-appropriate content before production launch.</p></div></main>
}
