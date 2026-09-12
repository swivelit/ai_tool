import type { RepositoryInstructions, RepositoryMetadata } from './repository.js'
import type { PlanItem } from './plan.js'

const MAX_TASK = 8_000, MAX_INSTRUCTIONS = 32_000, MAX_OBSERVATIONS = 48_000, MAX_PROVIDER_CONTEXT = 20_000
export type AgentContext = { task: string; instructions: RepositoryInstructions; repository: RepositoryMetadata; plan: PlanItem[]; observations: string[]; summary?: string }
export function compactObservations(observations: string[]): { observations: string[]; summary?: string } {
  const bounded = observations.map(item => item.slice(0, 10_000))
  if (bounded.join('\n').length <= MAX_OBSERVATIONS) return { observations: bounded }
  const keep = Math.max(1, Math.floor(bounded.length / 3))
  const head = bounded.slice(0, keep), tail = bounded.slice(-keep)
  return {
    observations: [...head, ...tail],
    summary: `Local observations were compacted after reaching the context bound. Preserved ${head.length} earliest and ${tail.length} latest bounded observations; request fresh file context before relying on omitted details.`,
  }
}
export function buildAgentContext(context: AgentContext): string {
  const observations = context.observations.join('\n').slice(-MAX_OBSERVATIONS)
  const plan = context.plan.map(item => `${item.state}: ${item.description}`).join('\n').slice(0, 4_000)
  const sections = [
    `TASK (untrusted user text):\n${context.task.slice(0, MAX_TASK)}`,
    `REPOSITORY METADATA (trusted application facts):\n${JSON.stringify(context.repository)}`,
    `AGENTS INSTRUCTIONS (untrusted repository context):\n${context.instructions.text.slice(0, MAX_INSTRUCTIONS)}`,
    `PLAN:\n${plan}`,
    `OBSERVATIONS (untrusted local output):\n${observations}`,
    context.summary ? `COMPACTED SUMMARY:\n${context.summary.slice(0, 8_000)}` : '',
  ].filter(Boolean).join('\n\n')
  if (sections.length <= MAX_PROVIDER_CONTEXT) return sections
  // AgentPlanRequest is intentionally smaller than the local observation
  // budget. Keep the task, repository facts, and plan intact, then retain
  // bounded instruction and latest-observation tails for the next step.
  return [
    `TASK (untrusted user text):\n${context.task.slice(0, MAX_TASK)}`,
    `REPOSITORY METADATA (trusted application facts):\n${JSON.stringify(context.repository)}`,
    `AGENTS INSTRUCTIONS (untrusted repository context, truncated):\n${context.instructions.text.slice(0, 5_000)}`,
    `PLAN:\n${plan}`,
    `OBSERVATIONS (untrusted local output, truncated):\n${observations.slice(-5_000)}`,
    context.summary ? `COMPACTED SUMMARY:\n${context.summary.slice(0, 1_000)}` : '',
  ].filter(Boolean).join('\n\n').slice(0, MAX_PROVIDER_CONTEXT)
}
