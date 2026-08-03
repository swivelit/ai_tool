import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const MAX_OUTPUT_BYTES = 256 * 1024
const ALLOWED_REPOSITORY_PATHS = new Set([
  'src/pricing.js', 'src/orderService.js', 'test/order.test.js',
])

export type IsolatedRunResult = {
  accepted: boolean
  passed: boolean
  reasonCode: string
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  networkIsolation: 'environment_only'
}

function bounded(value: unknown): string {
  return String(value ?? '').slice(0, MAX_OUTPUT_BYTES)
}

function rejected(reasonCode: string, command: string): IsolatedRunResult {
  return {
    accepted:false, passed:false, reasonCode, command, exitCode:null,
    stdout:'', stderr:'', networkIsolation:'environment_only',
  }
}

export async function assertPythonTestRuntimeAvailable(): Promise<void> {
  try {
    await execute('python', ['-m', 'pytest', '--version'], {
      timeout:10_000,
      maxBuffer:MAX_OUTPUT_BYTES,
      env:{
        PATH:process.env.PATH,
        PYTHONDONTWRITEBYTECODE:'1',
        PYTHONNOUSERSITE:'1',
        PYTEST_DISABLE_PLUGIN_AUTOLOAD:'1',
      },
    })
  } catch {
    throw new Error('python_test_runtime_unavailable')
  }
}

export function extractPythonBlocks(markdown: string): string[] {
  return [...String(markdown).matchAll(/```python\s*\n([\s\S]*?)```/gi)]
    .map(match => match[1].replace(/\s+$/, ''))
}

function validatePythonBlock(
  source: string,
  kind: 'pricing' | 'tests',
): string | null {
  const forbidden = /\b(?:open|exec|eval|compile|__import__|breakpoint|input)\s*\(|\b(?:os|sys|subprocess|socket|requests|urllib|pathlib|shutil|tempfile|importlib)\b|\.\s*__\w+__/i
  if (forbidden.test(source)) return 'python_unsafe_construct'
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!/^(?:from|import)\s+/.test(trimmed)) continue
    if (kind === 'pricing') {
      if (!/^from decimal import (?:Decimal|ROUND_HALF_UP)(?:\s*,\s*(?:Decimal|ROUND_HALF_UP))*$/.test(trimmed)) {
        return 'python_unexpected_import'
      }
    } else if (!(
      /^import pytest$/.test(trimmed)
      || /^from decimal import Decimal$/.test(trimmed)
      || /^from pricing import apply_discount$/.test(trimmed)
    )) return 'python_unexpected_import'
  }
  return null
}

export async function testGeneratedDiscountPython(
  markdown: string,
): Promise<IsolatedRunResult> {
  const command = 'python -m pytest -q'
  const blocks = extractPythonBlocks(markdown)
  if (blocks.length !== 2) return rejected('python_block_count', command)
  if (!blocks[0].startsWith('# pricing.py')) {
    return rejected('python_pricing_header', command)
  }
  if (!blocks[1].startsWith('# test_pricing.py')) {
    return rejected('python_tests_header', command)
  }
  const pricingFailure = validatePythonBlock(blocks[0], 'pricing')
  const testsFailure = validatePythonBlock(blocks[1], 'tests')
  if (pricingFailure || testsFailure) {
    return rejected(pricingFailure ?? testsFailure!, command)
  }
  const directory = await mkdtemp(join(tmpdir(), 'swico-capability-python-'))
  try {
    await writeFile(join(directory, 'pricing.py'), `${blocks[0]}\n`, { mode:0o600 })
    await writeFile(join(directory, 'test_pricing.py'), `${blocks[1]}\n`, { mode:0o600 })
    await writeFile(join(directory, 'test_hidden.py'), `from decimal import Decimal
import pytest
from pricing import apply_discount

def test_expected_discount():
    assert apply_discount(Decimal("100.00"), Decimal("15")) == Decimal("85.00")

@pytest.mark.parametrize("percent, expected", [
    (Decimal("0"), Decimal("100.00")),
    (Decimal("100"), Decimal("0.00")),
])
def test_boundaries(percent, expected):
    assert apply_discount(Decimal("100.00"), percent) == expected

def test_negative_total():
    with pytest.raises((ValueError, TypeError)):
        apply_discount(Decimal("-0.01"), Decimal("10"))

@pytest.mark.parametrize("percent", [Decimal("-0.01"), Decimal("100.01")])
def test_invalid_percent(percent):
    with pytest.raises((ValueError, TypeError)):
        apply_discount(Decimal("100.00"), percent)

def test_round_half_up():
    assert apply_discount(Decimal("0.05"), Decimal("10")) == Decimal("0.05")
    assert apply_discount(Decimal("0.15"), Decimal("10")) == Decimal("0.14")
`, { mode:0o600 })
    try {
      const result = await execute('python', ['-m', 'pytest', '-q'], {
        cwd:directory,
        timeout:15_000,
        maxBuffer:MAX_OUTPUT_BYTES,
        env:{
          PATH:process.env.PATH,
          PYTHONDONTWRITEBYTECODE:'1',
          PYTHONNOUSERSITE:'1',
          PYTEST_DISABLE_PLUGIN_AUTOLOAD:'1',
          HTTP_PROXY:'', HTTPS_PROXY:'', ALL_PROXY:'', NO_PROXY:'*',
        },
      })
      return {
        accepted:true, passed:true, reasonCode:'passed', command,
        exitCode:0, stdout:bounded(result.stdout), stderr:bounded(result.stderr),
        networkIsolation:'environment_only',
      }
    } catch (error) {
      const value = error as { code?: unknown; killed?: boolean; stdout?: unknown; stderr?: unknown }
      return {
        accepted:true, passed:false,
        reasonCode:value.killed ? 'python_test_timeout' : 'python_tests_failed',
        command,
        exitCode:Number.isInteger(value.code) ? Number(value.code) : null,
        stdout:bounded(value.stdout), stderr:bounded(value.stderr),
        networkIsolation:'environment_only',
      }
    }
  } finally {
    await rm(directory, { recursive:true, force:true })
  }
}

export function extractUnifiedDiff(markdown: string): string | null {
  const fenced = String(markdown).match(/```diff\s*\n([\s\S]*?)```/i)
  if (fenced) return fenced[1].replace(/\s+$/, '') + '\n'
  const start = String(markdown).search(/^diff --git /m)
  return start >= 0 ? String(markdown).slice(start).replace(/\s+$/, '') + '\n' : null
}

export function validateRepositoryDiff(diff: string): string | null {
  if (!diff.trim()) return 'repository_diff_missing'
  if (/GIT binary patch|Binary files |^new file mode 120000|^old mode 120000/m.test(diff)) {
    return 'repository_binary_or_symlink_patch'
  }
  if (/package\.json|package-lock\.json|npm\s+(?:run|test|install|ci)|\b(?:curl|wget|bash|sh)\b/i.test(diff)) {
    return 'repository_forbidden_patch_content'
  }
  const paths = [...diff.matchAll(/^(?:---|\+\+\+)\s+(?:a\/|b\/)?([^\t\r\n ]+)/gm)]
    .map(match => match[1]).filter(path => path !== '/dev/null')
  if (!paths.length) return 'repository_diff_paths_missing'
  for (const path of paths) {
    if (path.startsWith('/') || path.split('/').includes('..')) {
      return 'repository_path_traversal'
    }
    if (!ALLOWED_REPOSITORY_PATHS.has(path)) {
      return 'repository_path_not_allowlisted'
    }
  }
  return null
}

async function writeRepositoryFixture(directory: string): Promise<void> {
  await mkdir(join(directory, 'src'), { recursive:true })
  await mkdir(join(directory, 'test'), { recursive:true })
  await writeFile(join(directory, 'package.json'), `{
  "type": "module",
  "scripts": { "test": "node --test" },
  "engines": { "node": ">=20" }
}\n`)
  await writeFile(join(directory, 'src/pricing.js'), `export function finalPrice(subtotalCents, discountPercent) {
  if (!Number.isInteger(subtotalCents) || subtotalCents < 0) {
    throw new TypeError('subtotalCents must be a non-negative integer')
  }
  if (!Number.isInteger(discountPercent)) {
    throw new TypeError('discountPercent must be an integer')
  }
  return subtotalCents - discountPercent
}\n`)
  await writeFile(join(directory, 'src/orderService.js'), `import { finalPrice } from './pricing.js'

export function createOrder(order) {
  return { id: order.id, totalCents: finalPrice(order.subtotalCents, order.discountRate) }
}\n`)
  await writeFile(join(directory, 'test/order.test.js'), `import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrder } from '../src/orderService.js'
import { finalPrice } from '../src/pricing.js'
test('applies a percentage discount', () => assert.equal(finalPrice(10000, 15), 8500))
test('creates an order', () => assert.deepEqual(createOrder({ id:'ORDER-1', subtotalCents:10000, discountPercent:15 }), { id:'ORDER-1', totalCents:8500 }))
test('rejects invalid percentage', () => assert.throws(() => finalPrice(10000, 101)))
`)
}

export async function testRepositoryPatch(markdown: string): Promise<IsolatedRunResult> {
  const command = 'npm test'
  const diff = extractUnifiedDiff(markdown)
  if (!diff) return rejected('repository_diff_missing', command)
  const validationFailure = validateRepositoryDiff(diff)
  if (validationFailure) return rejected(validationFailure, command)
  const directory = await mkdtemp(join(tmpdir(), 'swico-capability-repository-'))
  try {
    await writeRepositoryFixture(directory)
    const patchPath = join(directory, 'answer.diff')
    await writeFile(patchPath, diff, { mode:0o600 })
    try {
      await execute('git', ['apply', '--check', '--recount', '--whitespace=error-all', patchPath], {
        cwd:directory, timeout:5_000, maxBuffer:MAX_OUTPUT_BYTES,
      })
      await execute('git', ['apply', '--recount', '--whitespace=error-all', patchPath], {
        cwd:directory, timeout:5_000, maxBuffer:MAX_OUTPUT_BYTES,
      })
    } catch (error) {
      return {
        ...rejected('repository_patch_apply_failed', command),
        stderr:bounded((error as { stderr?: unknown }).stderr),
      }
    }
    await writeFile(join(directory, 'test/hidden.test.js'), `import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrder } from '../src/orderService.js'
import { finalPrice } from '../src/pricing.js'
test('hidden boundaries', () => {
  assert.equal(finalPrice(10000, 0), 10000)
  assert.equal(finalPrice(10000, 100), 0)
  assert.throws(() => finalPrice(10000, -1))
  assert.throws(() => finalPrice(10000, 101))
})
test('hidden order contract', () => assert.equal(createOrder({ id:'H', subtotalCents:10000, discountPercent:15 }).totalCents, 8500))
`)
    try {
      const result = await execute('npm', ['test'], {
        cwd:directory,
        timeout:20_000,
        maxBuffer:MAX_OUTPUT_BYTES,
        env:{
          PATH:process.env.PATH,
          NODE_OPTIONS:'--no-addons',
          npm_config_offline:'true', npm_config_audit:'false', npm_config_fund:'false',
          HTTP_PROXY:'', HTTPS_PROXY:'', ALL_PROXY:'', NO_PROXY:'*',
        },
      })
      return {
        accepted:true, passed:true, reasonCode:'passed', command, exitCode:0,
        stdout:bounded(result.stdout), stderr:bounded(result.stderr),
        networkIsolation:'environment_only',
      }
    } catch (error) {
      const value = error as { code?: unknown; killed?: boolean; stdout?: unknown; stderr?: unknown }
      return {
        accepted:true, passed:false,
        reasonCode:value.killed ? 'repository_test_timeout' : 'repository_tests_failed',
        command, exitCode:Number.isInteger(value.code) ? Number(value.code) : null,
        stdout:bounded(value.stdout), stderr:bounded(value.stderr),
        networkIsolation:'environment_only',
      }
    }
  } finally {
    await rm(directory, { recursive:true, force:true })
  }
}
