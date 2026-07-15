import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'

// TODO(LEGAL-BLOCKER): Replace every reviewed-content placeholder below with
// counsel-approved publication copy before accepting Razorpay Live Mode payments.
const pages: Record<string, { title: string; intro: string; sections: string[] }> = {
  terms: { title: 'Terms', intro: 'Rules for using Swico', sections: ['Eligibility and accounts', 'Acceptable use', 'AI credits and billing', 'Service availability', 'Liability and disputes'] },
  privacy: { title: 'Privacy', intro: 'How information is handled', sections: ['Information collected', 'How information is used', 'Service providers', 'Retention and deletion', 'Your choices and contact'] },
  refunds: { title: 'Refund policy', intro: 'Payment and refund information', sections: ['AI credit allocation', 'Eligibility for refunds', 'Partial usage and cancellations', 'Processing times', 'How to request support'] },
  ai: { title: 'AI limitations', intro: 'Important guidance for AI-generated responses', sections: ['Accuracy and verification', 'Professional advice', 'Provider processing', 'Cancellation and partial usage', 'Reporting a concern'] },
  contact: { title: 'Contact and support', intro: 'Ways to reach the Swico team', sections: ['Support channel', 'Billing support', 'Privacy requests', 'Response expectations', 'Business details'] },
}

export function LegalPage() {
  const { page } = useParams(); const content = pages[page ?? ''] ?? { title: 'Information', intro: 'Swico publication information', sections: ['Reviewed content'] }
  return <main className="legal-page"><Link to="/"><ArrowLeft size={16} /> Back to Swico</Link><div className="legal-heading"><span>Swico</span><h1>{content.title}</h1><p>{content.intro}</p></div>
    <aside className="legal-warning"><strong>Publication content pending legal review</strong><p>This structure is intentionally not legal advice or final policy text. Reviewed, jurisdiction-appropriate content is required before Razorpay Live Mode is accepted.</p></aside>
    <div className="legal-sections">{content.sections.map((section, index) => <section key={section}><span>{String(index + 1).padStart(2, '0')}</span><div><h2>{section}</h2><p>TODO: Insert reviewed publication content.</p></div></section>)}</div>
  </main>
}
