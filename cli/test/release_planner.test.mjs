import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planRelease } from '../scripts/plan-release.mjs'

const base = { repoVersion:'0.2.0', npmLatestVersion:'0.2.0' }

describe('automatic Swico CLI release planning', () => {
  it('skips web-only, docs-only, and cli test-only changes', () => {
    for (const path of ['web/src/App.tsx', 'docs/CLI.md', 'cli/test/agent.test.mjs', 'cli/scripts/release-check.mjs']) {
      assert.equal(planRelease({ ...base, changedPaths:[path] }).action, 'skip')
    }
  })

  it('plans one patch for release-worthy changes across multiple commits', () => {
    const plan = planRelease({ ...base, changedPaths:['cli/src/cli.ts', 'cli/src/api.ts', 'cli/README.md'] })
    assert.equal(plan.action, 'release')
    assert.equal(plan.version, '0.2.1')
    assert.equal(plan.needsVersionCommit, true)
  })

  it('reuses a pending repository version without incrementing it', () => {
    const plan = planRelease({ repoVersion:'0.2.1', npmLatestVersion:'0.2.0', changedPaths:['cli/src/cli.ts'] })
    assert.equal(plan.version, '0.2.1')
    assert.equal(plan.needsVersionCommit, false)
  })

  it('reuses 0.2.1 for the shipped usage change while it is pending', () => {
    const plan = planRelease({ repoVersion:'0.2.1', npmLatestVersion:'0.2.0', changedPaths:['cli/src/usage.ts'] })
    assert.equal(plan.action, 'release')
    assert.equal(plan.version, '0.2.1')
    assert.equal(plan.needsVersionCommit, false)
  })

  it('fails closed when npm is newer than the repository', () => {
    assert.throws(() => planRelease({ repoVersion:'0.2.0', npmLatestVersion:'0.2.1', changedPaths:['cli/src/cli.ts'] }), /version regression/)
  })

  it('does not overwrite an existing target version', () => {
    const plan = planRelease({ ...base, changedPaths:['cli/src/cli.ts'], targetExists:true })
    assert.equal(plan.action, 'skip')
    assert.match(plan.reason, /refusing to overwrite/)
  })
})
