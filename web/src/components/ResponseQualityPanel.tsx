import { CheckCircle2, CircleAlert, Info, ShieldCheck } from 'lucide-react'
import type { ResponseQuality } from '../types'

const LABELS: Record<ResponseQuality['status'], string> = {
  verified: 'Verified',
  checked: 'Structure checked; sources not verified',
  grounded: 'Sources checked',
  best_effort: 'Best effort',
  unverified: 'Could not fully verify',
  insufficient_evidence: 'Not enough supporting information',
}

const REASON_LABELS: Record<string, string> = {
  web_claim_not_supported: 'A cited web claim was not fully supported by its associated source.',
  unsupported_cited_section: 'A cited answer section needs more direct source support.',
  no_cited_sections: 'No source citation was attached to the factual answer.',
  provider_cited_grounding: 'Grounded in provider-cited web material; independent page verification was unavailable.',
  independent_source_support_unavailable: 'The available source did not independently establish the claim.',
  evidence_temporal_scope_not_established: 'The source did not establish the requested current time period.',
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
  if (quality.evidence_strength === 'provider_cited_grounding') {
    checkLabels.push('Provider-cited web grounding; independent verification unavailable')
  }
  const detailLabels = quality.checks.flatMap(check => {
    if (!['failed', 'warning', 'error'].includes(check.status) || !check.reason) return []
    return [REASON_LABELS[check.reason] ?? check.reason]
  })
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
    {detailLabels.length > 0 && <small>{[...new Set(detailLabels)].join(' · ')}</small>}
  </section>
}
