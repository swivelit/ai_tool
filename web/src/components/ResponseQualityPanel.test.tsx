import { render, screen } from '@testing-library/react'
import { ResponseQualityPanel } from './ResponseQualityPanel'

it.each([
  ['verified', 'Verified'],
  ['grounded', 'Sources checked'],
  ['best_effort', 'Best effort'],
  ['unverified', 'Could not fully verify'],
  ['insufficient_evidence', 'Not enough supporting information'],
] as const)('renders the safe human label for %s', (status, label) => {
  render(<ResponseQualityPanel quality={{
    status,
    retrieval_status: status === 'grounded' ? 'sufficient' : null,
    checks: [{ type:'citation_validity', status:'passed' }],
  }} />)
  expect(screen.getByText(label)).toBeInTheDocument()
  expect(screen.queryByText(/openai|sarvam|gpt|model/i)).not.toBeInTheDocument()
})
