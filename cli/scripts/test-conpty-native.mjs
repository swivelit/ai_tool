/* Native Windows-only release-test entry point. Never shipped in the CLI. */
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const runner = join(root, 'scripts', 'conpty_runner.mjs')
const deadlineMs = 12_000
const maxOutputBytes = 256 * 1024

function appendBounded(current, chunk) {
  const next = `${current}${chunk}`
  return Buffer.byteLength(next, 'utf8') <= maxOutputBytes ? next : next.slice(-maxOutputBytes)
}

function completion(stderr) {
  const line = String(stderr).split(/\r?\n/).findLast(value => value.startsWith('[conpty-result] '))
  if (!line) throw new Error('native helper emitted no completion sentinel')
  return JSON.parse(line.slice('[conpty-result] '.length))
}

function childScript(body) {
  return `process.stdout.write(${JSON.stringify(body)});`
}

async function runCase(name, script, expectedCode, options = {}) {
  const child = spawn(process.execPath, [runner, process.execPath, '-e', script], {
    cwd: root,
    env: { ...process.env, TERM: 'xterm-256color', SWICO_PTY_COLUMNS: '100', SWICO_PTY_ROWS: '32' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  let stdout = '', stderr = '', settled = false, timer
  const result = await new Promise((resolve, reject) => {
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    child.stdout.on('data', chunk => { stdout = appendBounded(stdout, stdoutDecoder.write(chunk)) })
    let parentEofSent = false
    child.stderr.on('data', chunk => {
      stderr = appendBounded(stderr, stderrDecoder.write(chunk))
      if (options.parentEof && !parentEofSent && stderr.includes('[conpty] child-started')) {
        parentEofSent = true
        child.stdin.end()
      }
    })
    child.once('error', error => finish({ error }))
    child.once('close', (code, signal) => finish({ code, signal, stdout: `${stdout}${stdoutDecoder.end()}`, stderr: `${stderr}${stderrDecoder.end()}` }))
    timer = setTimeout(() => {
      try { child.kill() } catch { /* the close handler records the outcome */ }
      finish({ timedOut: true, stdout, stderr })
    }, options.deadlineMs ?? deadlineMs)
  })
  if (result.timedOut) throw new Error(`${name}: helper did not close before deadline; stderr=${result.stderr?.slice(-1_000)}`)
  if (result.error) throw new Error(`${name}: helper spawn failed: ${result.error.message}`)
  const report = completion(result.stderr)
  if (result.signal) throw new Error(`${name}: helper signal ${result.signal}`)
  if (result.code !== expectedCode || report.helper_exit_code !== expectedCode) {
    throw new Error(`${name}: expected helper/child code ${expectedCode}, got helper=${result.code}, reported=${report.helper_exit_code}, child=${report.child_code}; stderr=${result.stderr.slice(-1_000)}`)
  }
  if (report.child_signal !== null || report.timedOut || report.forcedTermination || report.error_present) throw new Error(`${name}: completion contract was not clean`)
  return { name, code: result.code, report, stdout: result.stdout }
}

async function main() {
  if (process.platform !== 'win32') {
    process.stdout.write(JSON.stringify({ status: 'not_run', reason: 'native ConPTY acceptance is Windows-only' }) + '\n')
    return
  }

  const results = []
  // Keep the helper stdin open for natural exits. This is the regression that
  // previously left the helper alive after the bridge had already closed.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    results.push(await runCase(`natural-exit-${attempt + 1}`, childScript(`PTY_NATIVE_${attempt + 1}\n`), 0))
  }
  results.push(await runCase('nonzero-exit', childScript('PTY_NATIVE_7\n') + 'process.exitCode = 7;', 7))
  const unicode = await runCase('unicode-final-output', childScript('தமிழ் 😀\n' + 'TAIL'.repeat(20)), 0)
  if (!unicode.stdout.includes('தமிழ்') || !unicode.stdout.includes('😀') || !unicode.stdout.includes('TAIL')) throw new Error('unicode-final-output: final output was truncated')

  const eof = await runCase('parent-eof', `process.stdout.write('EOF_READY\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));`, 0, { parentEof: true })
  // This is deliberately sent only while the child is running; the helper's
  // bridge must not write EOT after a child-exit event.
  if (!eof.stdout.includes('EOF_READY')) throw new Error('parent-eof: marker was not observed')

  process.stdout.write(JSON.stringify({ status: 'passed', cases: results.map(({ name, code, report }) => ({ name, code, child_code: report.child_code, output_bytes: report.output_bytes, resources: report.active_resources })) }) + '\n')
}

try {
  await main()
} catch (error) {
  process.stderr.write(`native ConPTY acceptance failed: ${String(error?.message ?? error).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2_000)}\n`)
  process.exitCode = 1
}
