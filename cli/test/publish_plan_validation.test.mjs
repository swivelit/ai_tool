import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parsePackageMetadata,
  parsePublishedPackageIdentity,
  printPlan,
  validateExistingTarget,
} from '../scripts/validate-publish-plan.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

describe('publish-plan validation', () => {
  it('validates npm metadata and the bounded published build identity', () => {
    assert.deepEqual(
      parsePackageMetadata('{"name":"@swiveltechnologies/swico","version":"0.2.0"}', '@swiveltechnologies/swico'),
      { name: '@swiveltechnologies/swico', version: '0.2.0' },
    )
    assert.deepEqual(
      parsePublishedPackageIdentity({
        packageName: '@swiveltechnologies/swico',
        packageJsonText: '{"name":"@swiveltechnologies/swico","version":"0.2.0","bin":{"swico":"dist/cli.js"}}',
        identityText: 'export default Object.freeze({"revision":"13596694eec84836be5114271c943948fabc2486","dirty":false})',
      }),
      { version: '0.2.0', revision: '13596694eec84836be5114271c943948fabc2486' },
    )
  })

  it('rejects identity and target mismatches', () => {
    assert.throws(() => parsePackageMetadata('{"name":"other","version":"0.2.0"}', '@swiveltechnologies/swico'))
    assert.throws(() => parsePublishedPackageIdentity({
      packageName: '@swiveltechnologies/swico',
      packageJsonText: '{"name":"@swiveltechnologies/swico","version":"0.2.0","bin":{"swico":"dist/cli.js"}}',
      identityText: 'Object.freeze({"revision":"not-a-revision","dirty":false})',
    }))
    assert.throws(() => validateExistingTarget({
      responseText: '{"name":"@swiveltechnologies/swico","version":"0.2.0"}',
      packageName: '@swiveltechnologies/swico',
      targetVersion: '0.2.1',
    }))
  })

  it('renders a release plan without an inline shell heredoc', () => {
    assert.equal(printPlan({ reason: 'No Swico CLI package release required.', changedPaths: [] }), 'No Swico CLI package release required.\n')
    const workflow = readFileSync(resolve(repoRoot, '.github/workflows/publish-cli.yml'), 'utf8')
    const planStep = workflow.split('id: plan', 2)[1].split('\n  version:', 1)[0]
    assert.equal(/<<['"]?NODE/.test(planStep), false)
  })

  it('keeps all publish workflow Node validation out of shell heredocs', () => {
    const workflow = readFileSync(resolve(repoRoot, '.github/workflows/publish-cli.yml'), 'utf8')
    assert.equal(/<<['"]?NODE/.test(workflow), false)
  })
})
