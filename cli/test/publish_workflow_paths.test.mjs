import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(cliRoot, '..')
const workflowPath = resolve(repoRoot, '.github/workflows/publish-cli.yml')
const workflow = readFileSync(workflowPath, 'utf8')

function section(startMarker, endMarker) {
  const start = workflow.indexOf(startMarker)
  assert.notEqual(start, -1, `workflow is missing ${startMarker}`)
  const end = endMarker ? workflow.indexOf(endMarker, start) : workflow.length
  assert.notEqual(end, -1, `workflow is missing ${endMarker}`)
  return workflow.slice(start, end)
}

function nodeScriptReferences(step) {
  return [...step.matchAll(/node\s+([^\s"']+\.mjs)/g)].map(match => match[1])
}

function assertWorkflowYamlShape(text) {
  assert.doesNotMatch(text, /\t/, 'workflow YAML indentation must use spaces')
  assert.match(text, /^name:\s+\S.+$/m)
  assert.match(text, /^on:\s*$/m)
  assert.match(text, /^jobs:\s*$/m)
  assert.match(text, /^  canonical-artifact:\s*$/m)
  assert.match(text, /^  publish:\s*$/m)

  let blockIndent = null
  for (const line of text.split(/\r?\n/)) {
    if (blockIndent !== null) {
      const indentation = line.match(/^ */)[0].length
      if (line.trim() === '' || indentation > blockIndent) continue
      blockIndent = null
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indentation = line.match(/^ */)[0].length
    const content = line.trim()
    if (content.endsWith(': |') || content.endsWith(': >-') || content.endsWith(': >')) {
      blockIndent = indentation
      continue
    }
    assert.match(content, /^(?:-\s+)?(?:[^:#\n]+:\s*.*|[^:#\n]+)$/,
      `unexpected non-YAML workflow line: ${line}`)
  }
}

describe('publish workflow script paths', () => {
  it('resolves canonical-artifact scripts relative to its cli working directory', () => {
    const artifactStep = section(
      '      - name: Validate and stage exactly two flat files',
      '      - name: Upload flat canonical release artifact',
    )
    assert.match(artifactStep, /working-directory: cli\n/)
    for (const script of [
      'scripts/validate-release-artifact.mjs',
      'scripts/validate-publish-plan.mjs',
      'scripts/validate-canonical-artifact.mjs',
    ]) {
      assert.equal(existsSync(resolve(cliRoot, script)), true, script)
      assert.match(artifactStep, new RegExp(`node ${script.replaceAll('.', '\\.')}`))
    }
    for (const script of nodeScriptReferences(artifactStep)) {
      assert.equal(resolve(cliRoot, script), resolve(repoRoot, 'cli', script), script)
    }
    assert.doesNotMatch(artifactStep, /node cli\/scripts\/validate-canonical-artifact\.mjs/)
    assert.equal(existsSync(resolve(cliRoot, 'cli/scripts/validate-canonical-artifact.mjs')), false)
  })

  it('keeps publish-job cli-relative script paths rooted at the repository', () => {
    const publishJob = section('  publish:\n')
    assert.doesNotMatch(publishJob, /working-directory:/)
    const scripts = nodeScriptReferences(publishJob).filter(script => script.startsWith('cli/'))
    assert.deepEqual(scripts, [
      'cli/scripts/validate-canonical-artifact.mjs',
      'cli/scripts/validate-release-artifact.mjs',
      'cli/scripts/validate-publish-plan.mjs',
    ])
    for (const script of scripts) {
      assert.equal(existsSync(resolve(repoRoot, script)), true, script)
    }
  })

  it('keeps the canonical validator executable by Node', () => {
    const script = resolve(cliRoot, 'scripts/validate-canonical-artifact.mjs')
    assert.equal(existsSync(script), true)
    const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' })
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, result.stderr)
  })

  it('keeps the workflow as a valid YAML-shaped document', () => {
    assertWorkflowYamlShape(workflow)
  })
})
