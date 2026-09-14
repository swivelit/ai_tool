/* Dev/release-check helper only. It is not included by npm pack. */
import * as pty from 'node-pty'

if (process.platform !== 'win32' || process.argv.length < 3) {
  process.stderr.write('ConPTY acceptance requires Windows and a child command.\n')
  process.exitCode = 64
} else {
  const [command, ...args] = process.argv.slice(2)
  const columns = Number.parseInt(process.env.SWICO_PTY_COLUMNS ?? '100', 10)
  const rows = Number.parseInt(process.env.SWICO_PTY_ROWS ?? '32', 10)
  const child = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: Number.isFinite(columns) && columns > 0 ? columns : 100,
    rows: Number.isFinite(rows) && rows > 0 ? rows : 32,
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' },
    useConpty: true,
  })
  let settled = false
  let deadline
  const finish = (code, signal = 0) => {
    if (settled) return
    settled = true
    if (deadline) clearTimeout(deadline)
    process.exitCode = code || (signal ? 128 + signal : 0)
  }
  child.onData(value => process.stdout.write(value))
  child.onExit(({ exitCode, signal }) => finish(exitCode, signal))
  process.stdin.on('data', chunk => child.write(Buffer.from(chunk).toString('utf8')))
  process.stdin.on('end', () => child.write('\u0004'))
  const stop = () => { if (!settled) child.kill() }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  deadline = setTimeout(() => { stop(); setTimeout(() => { if (!settled) child.kill() }, 1_000) }, 40_000)
}
