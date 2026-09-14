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
export async function releaseReadiness(root: string): Promise<ReleaseReadiness> {
  const status = createSandboxAdapter(root).status()
  const sandbox = await verifySandbox(root)
  const credential = await credentialStorageStatus()
  const config = await loadConfig(root)
  const sandboxReady: ReadinessState = sandbox.verified ? 'ready' : 'blocked'
  // Check the package being released, not an unrelated license at the
  // workspace root. The current package intentionally has no license until
  // the owner makes that decision.
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
  if (!sandbox.verified) required_blockers.push(`Local agent sandbox is not verified: ${sandbox.diagnostic}`)
  if (license === 'blocked') required_blockers.push('No approved package license metadata or referenced notice is present; public npm release requires an explicit licensing decision.')
  const mcpHasStdio = config.effective.mcp.some(item => item.transport === 'stdio')
  const checks: ReleaseReadiness['checks'] = {
    // An offline check cannot prove an authenticated end-to-end Chat turn.
    chat_ready: 'unverified',
    credential_store_ready: /unavailable/i.test(credential) ? 'blocked' : 'ready',
    agent_sandbox_ready: sandboxReady,
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
    optional_notes: [
      `Sandbox readiness probe: ${status.implementation} (${status.diagnostic}).`,
      'Chat readiness is unverified offline; use doctor and a controlled authenticated smoke test to prove the deployed API path.',
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
