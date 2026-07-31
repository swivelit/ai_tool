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

it('renders safe repository check summaries without internal details', () => {
  render(<ResponseQualityPanel quality={{
    status:'unverified',
    retrieval_status:'sufficient',
    checks:[
      { type:'repository_context', status:'passed' },
      { type:'repository_syntax', status:'passed' },
      { type:'repository_typecheck', status:'passed' },
      { type:'repository_test', status:'passed' },
      { type:'repository_validation', status:'skipped' },
    ],
  }} />)
  expect(screen.getByText(/Repository context used/)).toBeInTheDocument()
  expect(screen.getByText(/Syntax checks passed/)).toBeInTheDocument()
  expect(screen.getByText(/Typecheck passed/)).toBeInTheDocument()
  expect(screen.getByText(/Tests passed/)).toBeInTheDocument()
  expect(screen.getByText(/Validation unavailable/)).toBeInTheDocument()
  expect(screen.getByText(/Not repository-verified/)).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(
    /openai|gpt-|sarvam|validator url|stdout|stderr/i,
  )
})
