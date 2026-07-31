import { CheckCircle2, CircleAlert, Info, ShieldCheck } from 'lucide-react'
import type { ResponseQuality } from '../types'

const LABELS: Record<ResponseQuality['status'], string> = {
  verified: 'Verified',
  grounded: 'Sources checked',
  best_effort: 'Best effort',
  unverified: 'Could not fully verify',
  insufficient_evidence: 'Not enough supporting information',
}

export function ResponseQualityPanel({ quality }: { quality: ResponseQuality }) {
  const warning = quality.status === 'unverified'
    || quality.status === 'insufficient_evidence'
  const Icon = quality.status === 'verified'
    ? ShieldCheck
    : quality.status === 'grounded'
      ? CheckCircle2
      : warning ? CircleAlert : Info
  const warningCount = quality.checks.filter(
    check => ['failed', 'warning', 'error'].includes(check.status),
  ).length
  const checkLabels = quality.checks.flatMap(check => {
    if (check.type === 'repository_context' && check.status === 'passed') {
      return ['Repository context used']
    }
    if (check.type === 'repository_syntax' && check.status === 'passed') {
      return ['Syntax checks passed']
    }
    if (check.type === 'repository_typecheck' && check.status === 'passed') {
      return ['Typecheck passed']
    }
    if (check.type === 'repository_test' && check.status === 'passed') {
      return ['Tests passed']
    }
    if (
      check.type.startsWith('repository_')
      && ['skipped', 'error'].includes(check.status)
    ) {
      return ['Validation unavailable']
    }
    return []
  })
  if (
    quality.status === 'unverified'
    && quality.checks.some(check => check.type.startsWith('repository_'))
  ) {
    checkLabels.push('Not repository-verified')
  }
  return <section
    className={`response-quality ${warning ? 'warning' : 'ok'}`}
    aria-label="Response quality"
  >
    <Icon size={15} aria-hidden="true" />
    <span>{LABELS[quality.status]}</span>
    {warningCount > 0 && <small>
      {warningCount} {warningCount === 1 ? 'check needs' : 'checks need'} attention
    </small>}
    {checkLabels.length > 0 && <small>{[...new Set(checkLabels)].join(' · ')}</small>}
  </section>
}
