/* Dev/release-check helper only. It is not included by npm pack. */
import * as pty from 'node-pty'
import { runPtyBridge } from './conpty_bridge.mjs'

const writeComplete = (stream, text) => new Promise((resolve, reject) => {
  let settled = false
  const finish = error => {
    if (settled) return
    settled = true
    if (error) reject(error)
    else resolve()
  }
  try {
    stream.write(text, error => finish(error))
  } catch (error) {
    finish(error)
  }
})

function activeResourceSummary() {
  const names = typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo()
    : []
  const counts = {}
  for (const name of names) counts[name] = (counts[name] ?? 0) + 1
  return { total: names.length, types: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) }
}

function helperExitCode(result) {
  if (result.timedOut || result.forcedTermination) return 124
  if (result.error) return 70
  if (result.signal) return 128
  if (typeof result.code === 'number') return result.code
  return 70
}

function bridgeTimeoutMs() {
  if (process.env.SWICO_PTY_TEST_MODE !== '1') return undefined
  const value = Number.parseInt(process.env.SWICO_PTY_TEST_TIMEOUT_MS ?? '', 10)
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 20_000 ? value : undefined
}

async function main() {
  if (process.platform !== 'win32' || process.argv.length < 3) {
    await writeComplete(process.stderr, 'ConPTY acceptance requires Windows and a child command.\n')
    return 64
  }
  const [command, ...args] = process.argv.slice(2)
  const columns = Number.parseInt(process.env.SWICO_PTY_COLUMNS ?? '100', 10)
  const rows = Number.parseInt(process.env.SWICO_PTY_ROWS ?? '32', 10)
  const result = await runPtyBridge({
    pty,
    command,
    args,
    options: {
      name: 'xterm-256color',
      cols: Number.isFinite(columns) && columns > 0 ? columns : 100,
      rows: Number.isFinite(rows) && rows > 0 ? rows : 32,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
      useConpty: true,
    },
    input: process.stdin,
    output: process.stdout,
    timeoutMs: bridgeTimeoutMs(),
    diagnostics: message => process.stderr.write(`[conpty] ${message}\n`),
  })
  const immediatelyAfterBridge = activeResourceSummary()
  // A short diagnostic-only turn lets resources which are already scheduled
  // for disposal disappear from the first snapshot without extending the
  // release-check deadline or treating them as evidence of success.
  await new Promise(resolve => setTimeout(resolve, 50))
  const afterDiagnosticTurn = activeResourceSummary()
  const exitCode = helperExitCode(result)
  const sentinel = {
    child_code: typeof result.code === 'number' ? result.code : null,
    child_signal: result.signal ?? null,
    timedOut: Boolean(result.timedOut),
    forcedTermination: Boolean(result.forcedTermination),
    error_present: Boolean(result.error),
    output_bytes: Number.isSafeInteger(result.output_bytes) ? result.output_bytes : 0,
    bridge_reason: result.reason ?? null,
    helper_exit_code: exitCode,
    active_resources: { immediately_after_bridge: immediatelyAfterBridge, after_diagnostic_turn: afterDiagnosticTurn },
  }
  await writeComplete(process.stderr, `[conpty-result] ${JSON.stringify(sentinel)}\n`)

  // node-pty 1.1.0 can leave Windows ConPTY worker/socket resources alive
  // after the public bridge has completed. This process is an isolated
  // release-test helper, so only after the strict result and sentinel have
  // been flushed may it terminate itself with the real result code. The
  // shipped Swico process never uses this path.
  process.exit(exitCode)
}

try {
  const code = await main()
  if (typeof code === 'number') process.exitCode = code
} catch (error) {
  await writeComplete(process.stderr, `[conpty-result] ${JSON.stringify({
    child_code: null,
    child_signal: null,
    timedOut: false,
    forcedTermination: false,
    error_present: true,
    output_bytes: 0,
    bridge_reason: 'helper-error',
    helper_exit_code: 70,
    error: String(error?.message ?? error).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300),
    active_resources: activeResourceSummary(),
  })}\n`).catch(() => undefined)
  process.exit(70)
}
