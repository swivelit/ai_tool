/* Dev/release-check helper only. It is not included by npm pack. */
import * as pty from 'node-pty'
import { runPtyBridge } from './conpty_bridge.mjs'

if (process.platform !== 'win32' || process.argv.length < 3) {
  process.stderr.write('ConPTY acceptance requires Windows and a child command.\n')
  process.exitCode = 64
} else {
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
    diagnostics: message => process.stderr.write(`[conpty] ${message}\n`),
  })
  if (result.timedOut || result.forcedTermination) process.exitCode = 124
  else if (result.error) process.exitCode = 70
  else if (result.signal) process.exitCode = 128
  else if (typeof result.code === 'number') process.exitCode = result.code
  else process.exitCode = 70
}
