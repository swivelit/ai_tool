#!/usr/bin/env node

// Native diagnostic only. This deliberately reports unavailable/denied
// profiles and exits non-zero; it never turns a failed probe into readiness.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { arch, tmpdir } from 'node:os'
import { join } from 'node:path'
import { macSandboxProfiles } from '../dist/sandbox.js'

const command = '/usr/bin/sandbox-exec'
const root = mkdtempSync(join(tmpdir(), 'swico-macos-sandbox-diagnostic-'))
const writable = join(root, 'runtime-tmp')
const bounded = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512)
const classify = (result) => {
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') return 'timeout'
  if (result.signal === 'SIGABRT') return 'sandbox_abort'
  const stderr = `${result.stderr ?? ''} ${result.stdout ?? ''}`
  if (/syntax|parse|expecting|invalid|malformed/i.test(stderr)) return 'profile_rejected'
  if (/operation not permitted|not permitted|sandbox_apply|eacces/i.test(stderr)) return 'host_denied'
  if (result.status === 0) return 'passed'
  return 'failed'
}
const run = (name, profile) => {
  const result = spawnSync(command, ['-p', profile, '/usr/bin/true'], { encoding: 'utf8', timeout: 2_000 })
  return {
    stage: name,
    status: result.status,
    signal: result.signal,
    classification: classify(result),
    stderr: bounded(result.stderr),
  }
}

try {
  if (process.platform !== 'darwin') {
    console.error('macOS sandbox diagnostic requires macOS.')
    process.exitCode = 2
  } else if (!existsSync(command)) {
    console.log(JSON.stringify({ platform: process.platform, architecture: arch(), binary: command, binary_exists: false, stages: [] }, null, 2))
    process.exitCode = 1
  } else {
    const version = spawnSync(command, ['-h'], { encoding: 'utf8', timeout: 2_000 })
    const generated = macSandboxProfiles(root, writable)
    const base = '(version 1) (deny default)'
    const stages = [
      { name: 'allow-default', profile: '(version 1) (allow default)' },
      { name: 'deny-default', profile: base },
      { name: 'process-exec', profile: `${base} (allow process-exec)` },
      { name: 'process-fork', profile: `${base} (allow process-exec) (allow process-fork)` },
      { name: 'signal-self', profile: `${base} (allow process-exec) (allow process-fork) (allow signal (target self))` },
      { name: 'system-file-read', profile: `${base} (allow process-exec) (allow process-fork) (allow signal (target self)) (allow file-read* (subpath "/usr") (subpath "/System") (subpath "/Library"))` },
      { name: 'sysctl-read', profile: `${base} (allow process-exec) (allow process-fork) (allow signal (target self)) (allow file-read* (subpath "/usr") (subpath "/System") (subpath "/Library")) (allow sysctl-read)` },
      { name: 'actual-read-only-profile', profile: generated.readOnly },
      { name: 'actual-workspace-write-profile', profile: generated.workspaceWrite },
    ].map(({ name, profile }) => run(name, profile))
    console.log(JSON.stringify({
      platform: process.platform,
      architecture: arch(),
      binary: command,
      binary_exists: true,
      binary_probe: { status: version.status, signal: version.signal, stderr: bounded(version.stderr) },
      stages,
      native_ready: stages.every((stage) => stage.classification === 'passed'),
    }, null, 2))
    process.exitCode = stages.every((stage) => stage.classification === 'passed') ? 0 : 1
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
