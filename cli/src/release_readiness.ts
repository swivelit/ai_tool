import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { credentialStorageStatus } from './credentials.js'
import { createSandboxAdapter, verifySandbox, type SandboxVerification } from './sandbox.js'
import { loadConfig } from './configuration.js'

export type ReadinessState = 'ready' | 'blocked' | 'unverified' | 'disabled-optional'
export type ReleaseReadiness = {
  workspace: string
  checks: {
    chat_ready: ReadinessState
    credential_store_ready: ReadinessState
    agent_sandbox_ready: ReadinessState
    agent_e2e_ready: ReadinessState
    agent_pilot_ready: ReadinessState
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
  agent_blockers: string[]
  optional_notes: string[]
}

export type InstalledAgentEvidence = {
  schema_version: 1
  status: 'passed'
  package: '@swiveltechnologies/swico'
  version: string
  artifact_sha256: string
  platform: string
  architecture: string
  installed_launcher: true
  launcher_preflight: { launcher: string; target: string; version: string; help_checked: true }
  host_network_control_reachable: true
  network_sandbox_denied: true
  sandbox_verified: true
  hostile_probes_passed: true
  cancellation_passed: true
  unknown_outcome_reconciliation_passed: true
  scenario: 'installed-agent-coding-loop'
  action_count: number
  result_count: number
  settlement_count: 1
  final_diff_sha256: string
  completed_at: string
}

export async function readInstalledAgentEvidence(env: NodeJS.ProcessEnv = process.env): Promise<{ state: 'ready' | 'unverified'; reason: string; evidence?: InstalledAgentEvidence }> {
  const path = env.SWICO_CLI_AGENT_E2E_EVIDENCE
  if (!path) return { state: 'unverified', reason: 'No installed-agent acceptance evidence file was configured.' }
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<InstalledAgentEvidence>
    const packageManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { name?: unknown; version?: unknown }
    const completed = Date.parse(String(value.completed_at ?? ''))
    const valid = value.schema_version === 1
      && value.status === 'passed'
      && value.package === (packageManifest.name ?? '@swiveltechnologies/swico')
      && value.version === packageManifest.version
      && value.artifact_sha256 !== undefined && /^[0-9a-f]{64}$/.test(value.artifact_sha256)
      && value.platform === process.platform
      && value.architecture === process.arch
      && value.installed_launcher === true
      && typeof value.launcher_preflight === 'object' && value.launcher_preflight !== null
      && (value.launcher_preflight as { version?: unknown }).version === packageManifest.version
      && (value.launcher_preflight as { help_checked?: unknown }).help_checked === true
      && value.host_network_control_reachable === true
      && value.network_sandbox_denied === true
      && value.cancellation_passed === true
      && value.unknown_outcome_reconciliation_passed === true
      && value.sandbox_verified === true
      && value.hostile_probes_passed === true
      && value.scenario === 'installed-agent-coding-loop'
      && typeof value.action_count === 'number' && Number.isInteger(value.action_count) && value.action_count > 0
      && value.result_count === value.action_count
      && value.settlement_count === 1
      && value.final_diff_sha256 !== undefined && /^[0-9a-f]{64}$/.test(value.final_diff_sha256)
      && Number.isFinite(completed) && completed > Date.now() - 7 * 24 * 60 * 60 * 1_000 && completed <= Date.now() + 5 * 60 * 1_000
    if (!valid) return { state: 'unverified', reason: 'Installed-agent acceptance evidence is malformed, stale, incomplete, or does not match this package/runtime.' }
    return { state: 'ready', reason: 'The installed launcher completed the bounded coding-loop, hostile-action, cancellation, unknown-outcome, and exactly-once settlement acceptance.', evidence: value as InstalledAgentEvidence }
  } catch { return { state: 'unverified', reason: 'Installed-agent acceptance evidence could not be read.' } }
}

// Keep this deliberately small and syntax-focused. The owner still has to
// choose the terms; an arbitrary non-empty package.json string is not a
// licensing decision.
const SPDX_IDS = new Set(['0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MIT', 'MPL-2.0', 'Unicode-DFS-2016', 'Unlicense'])

export function validPackageLicense(value: string): boolean {
  const license = value.trim()
  const reference = /^SEE LICENSE IN ([A-Za-z0-9._-]+)$/i.exec(license)
  if (reference) return reference[1].toLowerCase() !== 'package.json'
  const tokens = license.match(/AND|OR|WITH|[A-Za-z0-9.-]+|\(|\)/g)
  if (!tokens || tokens.join('') !== license.replace(/\s+/g, '')) return false
  let expectExpression = true
  let depth = 0
  for (const token of tokens) {
    if (expectExpression) {
      if (token === '(') { depth += 1; continue }
      if (!SPDX_IDS.has(token)) return false
      expectExpression = false
    } else if (token === ')') {
      if (depth === 0) return false
      depth -= 1
    } else if (token === 'AND' || token === 'OR') {
      expectExpression = true
    } else if (token === 'WITH') {
      expectExpression = true
    } else return false
  }
  return !expectExpression && depth === 0
}

/** Readiness is deliberately local and non-charging. It never contacts the API. */
export async function releaseReadiness(root: string, env: NodeJS.ProcessEnv = process.env): Promise<ReleaseReadiness> {
  const status = createSandboxAdapter(root).status()
  const sandbox = await verifySandbox(root)
  const credential = await credentialStorageStatus()
  const config = await loadConfig(root)
  const sandboxReady: ReadinessState = sandbox.verified ? 'ready' : 'blocked'
  const installedE2e = await readInstalledAgentEvidence(env)
  // Check the package being released, not an unrelated license at the
  // workspace root. Package terms are scoped to the first-party CLI; this
  // check does not license the rest of the monorepo or authorize publication.
  let packageLicense = ''
  let licenseReferenceExists = false
  try {
    const packageRoot = new URL('../', import.meta.url)
    const packageManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { license?: unknown }
    packageLicense = String(packageManifest.license ?? '').trim()
    const reference = /^SEE LICENSE IN ([A-Za-z0-9._-]+)$/i.exec(packageLicense)
    licenseReferenceExists = Boolean(reference && await readFile(new URL(reference[1], packageRoot), 'utf8').then(text => text.trim().length > 0).catch(() => false))
  } catch { /* reported as blocked */ }
  const license = packageLicense && packageLicense.toUpperCase() !== 'UNLICENSED' && validPackageLicense(packageLicense) && (!/^SEE LICENSE IN /i.test(packageLicense) || licenseReferenceExists) ? 'ready' : 'blocked'
  const required_blockers: string[] = []
  const agent_blockers: string[] = []
  if (!sandbox.verified) agent_blockers.push(`Local agent sandbox is not verified: ${sandbox.diagnostic}`)
  if (installedE2e.state !== 'ready') agent_blockers.push(installedE2e.reason)
  if (license === 'blocked') required_blockers.push('Package license metadata or its referenced notice is invalid; public npm release remains blocked until approved terms are present.')
  const mcpHasStdio = config.effective.mcp.some(item => item.transport === 'stdio')
  const checks: ReleaseReadiness['checks'] = {
    // An offline check cannot prove an authenticated end-to-end Chat turn.
    chat_ready: 'unverified',
    credential_store_ready: /unavailable/i.test(credential) ? 'blocked' : 'ready',
    agent_sandbox_ready: sandboxReady,
    agent_e2e_ready: installedE2e.state,
    agent_pilot_ready: sandbox.verified && installedE2e.state === 'ready' ? 'ready' : 'blocked',
    // HTTP MCP does not become ready merely because a local sandbox passed;
    // stdio MCP additionally requires a verified local runtime.
    mcp_ready: mcpHasStdio && !sandbox.verified ? 'blocked' : 'unverified',
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
    agent_blockers,
    optional_notes: [
      `Sandbox readiness probe: ${status.implementation} (${status.diagnostic}).`,
      'Chat readiness is unverified offline; use doctor and a controlled authenticated smoke test to prove the deployed API path.',
      'Images, web search, and model-backed subagents have no live-provider verification in this check.',
      `Local agent end-to-end acceptance: ${installedE2e.reason}${agent_blockers.length ? ` Current agent blocker: ${agent_blockers[0]}` : ''}`,
      'Cloud execution is optional and remains fail-closed until an isolated runner is configured.',
    ],
  }
}

export function formatReadiness(report: ReleaseReadiness): string {
  const lines = ['Swico release readiness', `Workspace: ${report.workspace}`]
  for (const [name, state] of Object.entries(report.checks)) lines.push(`${name}: ${state}`)
  lines.push(`Sandbox verification: ${report.sandbox.verified ? 'passed' : 'not passed'} (${report.sandbox.diagnostic})`)
  if (report.required_blockers.length) lines.push('', 'Required blockers:', ...report.required_blockers.map(item => `- ${item}`))
  if (report.agent_blockers.length) lines.push('', 'Local-agent blockers:', ...report.agent_blockers.map(item => `- ${item}`))
  if (report.optional_notes.length) lines.push('', 'Notes:', ...report.optional_notes.map(item => `- ${item}`))
  return lines.join('\n')
}
