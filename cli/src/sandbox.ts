import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdirSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

export type SandboxPolicy = 'read-only' | 'workspace-write'
export type NetworkPolicy = 'disabled' | 'allowed'
export type SandboxStatus = {
  implementation: 'macos-sandbox-exec' | 'linux-bubblewrap' | 'unavailable'
  available: boolean
  reason: string
  policy: SandboxPolicy
  network: NetworkPolicy
  writable_roots: string[]
}
export type SandboxAdapter = {
  status(): SandboxStatus
  wrap(argv: string[], policy?: SandboxPolicy, network?: NetworkPolicy): { command: string; args: string[] }
  spawn(argv: string[], options: SpawnOptions & { policy?: SandboxPolicy; network?: NetworkPolicy }): ChildProcess
}

function commandExists(value: string): boolean { try { execFileSync('sh', ['-c', `command -v ${value}`], { stdio: 'ignore' }); return true } catch { return false } }
function safeRoot(value: string): string { return realpathSync(value) }
function macRuntimeReady(): boolean {
  try { execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow process-exec)', '/usr/bin/true'], { stdio: 'ignore', timeout: 2_000 }); return true } catch { return false }
}
function bubblewrapReady(): boolean {
  try { execFileSync('bwrap', ['--die-with-parent', '--ro-bind', '/', '/', '--', '/usr/bin/true'], { stdio: 'ignore', timeout: 2_000 }); return true } catch { return false }
}
function macProfile(root: string, policy: SandboxPolicy, network: NetworkPolicy, writable: string): string {
  const files = `(subpath ${JSON.stringify(root)})`, writes = policy === 'workspace-write' ? `(subpath ${JSON.stringify(root)})` : `(subpath ${JSON.stringify(writable)})`
  return `(version 1)\n(deny default)\n(allow process-exec)\n(allow process-fork)\n(allow signal (target self))\n(allow file-read* (subpath "/usr") (subpath "/usr/local") (subpath "/opt/homebrew") (subpath "/bin") (subpath "/sbin") (subpath "/var") (subpath "/System") (subpath "/Library") ${files})\n(allow file-read-metadata ${files})\n(allow file-write* ${writes})\n(allow file-write-data ${writes})\n(allow sysctl-read)\n${network === 'allowed' ? '(allow network-outbound)' : ''}`
}

class MacSandbox implements SandboxAdapter {
  constructor(private readonly root: string) {}
  status(): SandboxStatus { return { implementation: 'macos-sandbox-exec', available: true, reason: 'macOS sandbox-exec policy enforcement is available.', policy: 'workspace-write', network: 'disabled', writable_roots: [this.root, join(tmpdir(), 'swico-sandbox')] } }
  wrap(argv: string[], policy: SandboxPolicy = 'workspace-write', network: NetworkPolicy = 'disabled'): { command: string; args: string[] } { const writable = join(tmpdir(), 'swico-sandbox'); mkdirSync(writable, { recursive: true, mode: 0o700 }); return { command: '/usr/bin/sandbox-exec', args: ['-p', macProfile(this.root, policy, network, writable), argv[0], ...argv.slice(1)] } }
  spawn(argv: string[], options: SpawnOptions & { policy?: SandboxPolicy; network?: NetworkPolicy }): ChildProcess {
    const wrapped = this.wrap(argv, options.policy, options.network)
    return spawn(wrapped.command, wrapped.args, { ...options, cwd: options.cwd ?? this.root, env: options.env })
  }
}

class LinuxBubblewrap implements SandboxAdapter {
  constructor(private readonly workspaceRoot: string) {}
  status(): SandboxStatus { return { implementation: 'linux-bubblewrap', available: true, reason: 'bubblewrap is installed and will create a mount, user, PID, and network namespace.', policy: 'workspace-write', network: 'disabled', writable_roots: ['/workspace', '/tmp'] } }
  private args(argv: string[], policy: SandboxPolicy, network: NetworkPolicy): string[] {
    const root = safeRoot(this.workspaceRoot), args = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-uts', '--unshare-ipc', '--ro-bind', '/usr', '/usr']
    for (const path of ['/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', '/usr/local']) {
      try { realpathSync(path); args.push('--ro-bind', path, path) } catch { /* optional system directory */ }
    }
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/workspace', '--chdir', '/workspace', '--setenv', 'HOME', '/tmp/swico-home', '--dir', '/tmp/swico-home')
    if (network === 'disabled') args.push('--unshare-net')
    args.push(policy === 'workspace-write' ? '--bind' : '--ro-bind', root, '/workspace', '--', argv[0], ...argv.slice(1))
    return args
  }
  wrap(argv: string[], policy: SandboxPolicy = 'workspace-write', network: NetworkPolicy = 'disabled'): { command: string; args: string[] } { return { command: 'bwrap', args: this.args(argv, policy, network) } }
  spawn(argv: string[], options: SpawnOptions & { policy?: SandboxPolicy; network?: NetworkPolicy }): ChildProcess {
    const root = safeRoot(this.workspaceRoot), policy = options.policy ?? 'workspace-write', network = options.network ?? 'disabled'
    return spawn('bwrap', this.args(argv, policy, network), { ...options, cwd: root, env: options.env })
  }
}

class UnavailableSandbox implements SandboxAdapter {
  constructor(private readonly reason: string, private readonly root: string) {}
  status(): SandboxStatus { return { implementation: 'unavailable', available: false, reason: this.reason, policy: 'read-only', network: 'disabled', writable_roots: [] } }
  wrap(): { command: string; args: string[] } { throw new Error(`Swico sandbox unavailable: ${this.reason}. Refusing unsandboxed execution.`) }
  spawn(): ChildProcess { throw new Error(`Swico sandbox unavailable: ${this.reason}. Refusing unsandboxed command execution.`) }
}

export function createSandboxAdapter(root: string, platform = process.platform): SandboxAdapter {
  const resolved = safeRoot(root)
  if (platform === 'darwin' && commandExists('sandbox-exec')) {
    if (macRuntimeReady()) return new MacSandbox(resolved)
    return new UnavailableSandbox('sandbox-exec is installed but the host refused to apply an OS sandbox policy.', resolved)
  }
  if (platform === 'linux' && commandExists('bwrap')) {
    if (bubblewrapReady()) return new LinuxBubblewrap(resolved)
    return new UnavailableSandbox('bubblewrap is installed but user/mount namespaces are unavailable on this host.', resolved)
  }
  return new UnavailableSandbox(platform === 'win32' ? 'Windows requires a reviewed native sandbox runtime; none is bundled.' : 'No supported OS-enforced sandbox runtime is installed.', resolved)
}

export function sandboxPathSummary(root: string): { workspace: string; home: string; outside_workspace: string } { return { workspace: safeRoot(root), home: homedir(), outside_workspace: relative(root, dirname(root)) } }
