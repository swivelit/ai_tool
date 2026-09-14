import test from 'node:test'
import assert from 'node:assert/strict'
import { quoteCmd, windowsShimInvocation } from '../scripts/windows-launcher.mjs'

test('Windows shim invocation preserves the cmd /s /c outer-quote boundary', () => {
  const invocation = windowsShimInvocation('C:\\runner path\\swico.cmd', ['--version', '--json', 'literal a&b'])
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/v:off', '/s'])
  assert.equal(invocation.args[4], '""C:\\runner path\\swico.cmd" "--version" "--json" "literal a&b""')
  assert.equal(invocation.options.windowsVerbatimArguments, true)
  assert.equal(invocation.options.windowsHide, true)
})

test('Windows shim quoting rejects command-boundary injection forms explicitly', () => {
  assert.equal(quoteCmd('literal a&b'), '"literal a&b"')
  assert.throws(() => quoteCmd('literal%PATH%'), /percent expansion/)
  assert.throws(() => quoteCmd('literal\nnext'), /control characters/)
  assert.throws(() => quoteCmd('literal"quote'), /quotes/)
})
