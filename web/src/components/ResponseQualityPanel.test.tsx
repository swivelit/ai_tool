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
    repository_validation_mode:null,
    checks: [{ type:'citation_validity', status:'passed' }],
  }} />)
  expect(screen.getByText(label)).toBeInTheDocument()
  expect(screen.queryByText(/openai|sarvam|gpt|model/i)).not.toBeInTheDocument()
})

it('explains provider-cited web grounding without calling it independently verified', () => {
  render(<ResponseQualityPanel quality={{
    status:'grounded', retrieval_status:'sufficient',
    repository_validation_mode:null,
    evidence_strength:'provider_cited_grounding',
    checks:[{
      type:'web_evidence_support', status:'failed', reason:'web_claim_not_supported',
    }],
  }} />)
  expect(screen.getByText(/Provider-cited web grounding/)).toBeInTheDocument()
  expect(screen.getByText(/cited web claim was not fully supported/)).toBeInTheDocument()
  expect(screen.queryByText(/independently verified/i)).not.toBeInTheDocument()
})

it('renders safe repository check summaries without internal details', () => {
  render(<ResponseQualityPanel quality={{
    status:'unverified',
    retrieval_status:'sufficient',
    repository_validation_mode:'static_only',
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
  expect(screen.queryByText(/Validation unavailable/)).not.toBeInTheDocument()
  expect(screen.getByText(/Static checks only/)).toBeInTheDocument()
  expect(screen.getByText(/Not repository-verified/)).toBeInTheDocument()
  expect(document.body.textContent).not.toMatch(
    /openai|gpt-|sarvam|validator url|stdout|stderr/i,
  )
})

it('uses repository verified only when every repository check passed', () => {
  const { rerender } = render(<ResponseQualityPanel quality={{
    status:'verified', retrieval_status:'sufficient',
    repository_validation_mode:'executable',
    checks:[
      { type:'repository_context', status:'passed' },
      { type:'repository_syntax', status:'passed' },
      { type:'repository_validation', status:'passed' },
    ],
  }} />)
  expect(screen.getByText(/Repository verified/)).toBeInTheDocument()
  rerender(<ResponseQualityPanel quality={{
    status:'verified', retrieval_status:'sufficient',
    repository_validation_mode:'executable',
    checks:[
      { type:'repository_context', status:'passed' },
      { type:'repository_syntax', status:'passed' },
      { type:'repository_validation', status:'skipped' },
    ],
  }} />)
  expect(screen.queryByText(/Repository verified/)).not.toBeInTheDocument()
  expect(screen.getByText('Could not fully verify')).toBeInTheDocument()
  expect(screen.getByText(/Not repository-verified/)).toBeInTheDocument()
})

it.each([
  ['static_only', 'Static checks only'],
  ['unavailable', 'Validation unavailable'],
] as const)('uses the explicit %s repository mode', (mode, label) => {
  render(<ResponseQualityPanel quality={{
    status:'unverified', retrieval_status:'sufficient',
    repository_validation_mode:mode,
    checks:[{ type:'repository_context', status:'passed' }],
  }} />)
  expect(screen.getByText(new RegExp(label))).toBeInTheDocument()
  expect(screen.queryByText(/Repository verified/)).not.toBeInTheDocument()
})

it('does not infer a mode or verification from check combinations', () => {
  render(<ResponseQualityPanel quality={{
    status:'verified', retrieval_status:'sufficient',
    repository_validation_mode:null,
    checks:[
      { type:'repository_syntax', status:'passed' },
      { type:'repository_validation', status:'passed' },
    ],
  }} />)
  expect(screen.getByText(/Syntax checks passed/)).toBeInTheDocument()
  expect(screen.queryByText(/Static checks only/)).not.toBeInTheDocument()
  expect(screen.queryByText(/Repository verified/)).not.toBeInTheDocument()
})
