import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { credentialStorageStatus } from './credentials.js'
import { createSandboxAdapter, verifySandbox, type SandboxVerification } from './sandbox.js'

export type ReadinessState = 'ready' | 'blocked' | 'unverified' | 'disabled-optional'
export type ReleaseReadiness = {
  workspace: string
  checks: {
    chat_ready: ReadinessState
    credential_store_ready: ReadinessState
    agent_sandbox_ready: ReadinessState
    mcp_ready: ReadinessState
    images_ready: ReadinessState
    search_ready: ReadinessState
    subagents_ready: ReadinessState
    cloud_ready: ReadinessState
    license_present: ReadinessState
  }
  sandbox: SandboxVerification
  credential_storage: string
  required_blockers: string[]
  optional_notes: string[]
}

/** Readiness is deliberately local and non-charging. It never contacts the API. */
export async function releaseReadiness(root: string): Promise<ReleaseReadiness> {
  const status = createSandboxAdapter(root).status()
  const sandbox = await verifySandbox(root)
  const credential = await credentialStorageStatus()
  const sandboxReady: ReadinessState = sandbox.verified ? 'ready' : 'blocked'
  const license = existsSync(join(root, 'LICENSE')) || existsSync(join(root, 'LICENSE.md')) ? 'ready' : 'blocked'
  const required_blockers: string[] = []
  if (!sandbox.verified) required_blockers.push(`Local agent sandbox is not verified: ${sandbox.diagnostic}`)
  if (license === 'blocked') required_blockers.push('No approved top-level LICENSE is present; public npm release requires an explicit licensing decision.')
  const checks: ReleaseReadiness['checks'] = {
    chat_ready: 'ready',
    credential_store_ready: /unavailable/i.test(credential) ? 'blocked' : 'ready',
    agent_sandbox_ready: sandboxReady,
    mcp_ready: sandbox.verified ? 'ready' : 'blocked',
    images_ready: 'unverified',
    search_ready: 'unverified',
    subagents_ready: 'unverified',
    cloud_ready: 'disabled-optional',
    license_present: license,
  }
  return {
    workspace: root,
    checks,
    sandbox,
    credential_storage: credential,
    required_blockers,
    optional_notes: [
      `Sandbox readiness probe: ${status.implementation} (${status.diagnostic}).`,
      'Images, web search, and model-backed subagents have no live-provider verification in this check.',
      'Cloud execution is optional and remains fail-closed until an isolated runner is configured.',
    ],
  }
}

export function formatReadiness(report: ReleaseReadiness): string {
  const lines = ['Swico release readiness', `Workspace: ${report.workspace}`]
  for (const [name, state] of Object.entries(report.checks)) lines.push(`${name}: ${state}`)
  lines.push(`Sandbox verification: ${report.sandbox.verified ? 'passed' : 'not passed'} (${report.sandbox.diagnostic})`)
  if (report.required_blockers.length) lines.push('', 'Required blockers:', ...report.required_blockers.map(item => `- ${item}`))
  if (report.optional_notes.length) lines.push('', 'Notes:', ...report.optional_notes.map(item => `- ${item}`))
  return lines.join('\n')
}
