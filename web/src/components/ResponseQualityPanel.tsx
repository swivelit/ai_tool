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
  const repositoryChecks = quality.checks.filter(
    check => check.type.startsWith('repository_'),
  )
  const repositoryVerified = quality.repository_validation_mode === 'executable'
    && quality.status === 'verified'
    && repositoryChecks.some(
      check => check.type === 'repository_validation'
        && check.status === 'passed',
    )
    && repositoryChecks.every(check => check.status === 'passed')
  const repositoryStaticOnly = quality.repository_validation_mode === 'static_only'
  const displayedStatus = (
    quality.status === 'verified' && repositoryChecks.some(
      check => ['skipped', 'failed', 'error'].includes(check.status),
    )
  ) ? 'unverified' : quality.status
  const warning = displayedStatus === 'unverified'
    || displayedStatus === 'insufficient_evidence'
  const Icon = displayedStatus === 'verified'
    ? ShieldCheck
    : displayedStatus === 'grounded'
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
    return []
  })
  if (repositoryStaticOnly) checkLabels.push('Static checks only')
  if (quality.repository_validation_mode === 'unavailable') {
    checkLabels.push('Validation unavailable')
  }
  if (repositoryVerified) checkLabels.push('Repository verified')
  if (displayedStatus === 'unverified' && repositoryChecks.length > 0) {
    checkLabels.push('Not repository-verified')
  }
  return <section
    className={`response-quality ${warning ? 'warning' : 'ok'}`}
    aria-label="Response quality"
  >
    <Icon size={15} aria-hidden="true" />
    <span>{LABELS[displayedStatus]}</span>
    {warningCount > 0 && <small>
      {warningCount} {warningCount === 1 ? 'check needs' : 'checks need'} attention
    </small>}
    {checkLabels.length > 0 && <small>{[...new Set(checkLabels)].join(' · ')}</small>}
  </section>
}
