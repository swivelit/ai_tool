import { spawn } from 'node:child_process'

function writeClipboard(command: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    let error = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Clipboard operation timed out.')) }, 5_000)
    child.stderr.on('data', chunk => { error = `${error}${chunk.toString()}`.slice(-1_000) })
    child.on('error', value => { clearTimeout(timer); reject(value) })
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(error || 'Clipboard command failed.')) })
    child.stdin.end(text)
  })
}

export async function copyToClipboard(text: string): Promise<void> {
  const command = process.platform === 'darwin' ? ['pbcopy', []] as const : process.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard']] as const : ['wl-copy', []] as const
  try { await writeClipboard(command[0], [...command[1]], text) }
  catch (error) {
    if (process.platform === 'linux') {
      try { await writeClipboard('xclip', ['-selection', 'clipboard'], text); return } catch { /* explicit error below */ }
    }
    throw new Error('Clipboard support is unavailable. Install pbcopy, wl-copy, or xclip and try again.')
  }
}
