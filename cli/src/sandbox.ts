import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

export type SandboxPolicy = 'read-only' | 'workspace-write'
export type NetworkPolicy = 'disabled' | 'allowed'
export type SandboxDiagnostic = 'ready' | 'binary_missing' | 'profile_rejected' | 'sandbox_apply_denied' | 'namespace_unavailable' | 'unsupported_platform'
export type IsolationCapability = 'proven' | 'available' | 'unverified' | 'unavailable'
export type SandboxStatus = {
  implementation: 'macos-sandbox-exec' | 'linux-bubblewrap' | 'unavailable'
  available: boolean
  diagnostic: SandboxDiagnostic
  reason: string
  policy: SandboxPolicy
  network: NetworkPolicy
  writable_roots: string[]
  filesystem_isolation: IsolationCapability
  network_isolation: IsolationCapability
  environment_isolation: IsolationCapability
  process_isolation: IsolationCapability
  supported_policies: SandboxPolicy[]
  runtime_version?: string
}
export type SandboxAdapter = {
  status(): SandboxStatus
  wrap(argv: string[], policy?: SandboxPolicy, network?: NetworkPolicy): { command: string; args: string[] }
  spawn(argv: string[], options: SpawnOptions & { policy?: SandboxPolicy; network?: NetworkPolicy }): ChildProcess
}

function commandExists(value: string): boolean { try { execFileSync('sh', ['-c', `command -v ${value}`], { stdio: 'ignore' }); return true } catch { return false } }
function safeRoot(value: string): string { return realpathSync(value) }
function errorOutput(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown }
  return [value.stderr, value.stdout, value.message].filter(item => typeof item === 'string').join('\n').slice(0, 500)
}
function macRuntimeDiagnostic(): { ready: boolean; diagnostic: SandboxDiagnostic; reason: string } {
  try { execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow process-exec)', '/usr/bin/true'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 2_000 }); return { ready: true, diagnostic: 'ready', reason: 'macOS sandbox-exec policy enforcement is available.' } }
  catch (error) {
    const detail = errorOutput(error)
    // Run a deliberately malformed profile only to separate profile parsing
    // from the host-level sandbox_apply denial. It never executes a command
    // under a malformed policy and the bounded diagnostic contains no secrets.
    try { execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1', '/usr/bin/true'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 2_000 }) }
    catch { /* expected parser rejection; keep the valid-profile diagnostic */ }
    if (/syntax|parse|invalid|malformed|unknown operation/i.test(detail)) return { ready: false, diagnostic: 'profile_rejected', reason: `sandbox-exec rejected its readiness profile${detail ? `: ${detail}` : '.'}` }
    // Some macOS/container hosts suppress sandbox-exec stderr for a denied
    // sandbox_apply. A failed valid-profile probe with no parse diagnostic is
    // therefore an application denial, never evidence that the policy works.
    return { ready: false, diagnostic: 'sandbox_apply_denied', reason: `sandbox-exec is installed but the host refused sandbox_apply${detail ? `: ${detail}` : ' (Operation not permitted).'}` }
  }
}
function bubblewrapDiagnostic(): { ready: boolean; diagnostic: SandboxDiagnostic; reason: string } {
  try { execFileSync('bwrap', ['--die-with-parent', '--ro-bind', '/', '/', '--', '/usr/bin/true'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 2_000 }); return { ready: true, diagnostic: 'ready', reason: 'bubblewrap is installed and will create a mount, user, PID, and network namespace.' } }
  catch (error) {
    const detail = errorOutput(error)
    return { ready: false, diagnostic: 'namespace_unavailable', reason: `bubblewrap is installed but user/mount namespaces are unavailable on this host${detail ? `: ${detail}` : '.'}` }
  }
}
function macProfile(root: string, policy: SandboxPolicy, network: NetworkPolicy, writable: string): string {
  const files = `(subpath ${JSON.stringify(root)})`, writes = policy === 'workspace-write' ? `(subpath ${JSON.stringify(root)})` : `(subpath ${JSON.stringify(writable)})`
  // Do not grant broad /var access: it includes user temporary data and can
  // turn an outside-workspace read into a false security boundary. The only
  // writable/readable temporary path is the private runtime directory below.
  return `(version 1)\n(deny default)\n(allow process-exec)\n(allow process-fork)\n(allow signal (target self))\n(allow file-read* (subpath "/usr") (subpath "/usr/local") (subpath "/opt/homebrew") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library") (subpath ${JSON.stringify(writable)}) ${files})\n(allow file-read-metadata ${files})\n(allow file-write* ${writes})\n(allow file-write-data ${writes})\n(allow sysctl-read)\n${network === 'allowed' ? '(allow network-outbound)' : ''}`
}

function capabilities(available: boolean): Pick<SandboxStatus, 'filesystem_isolation' | 'network_isolation' | 'environment_isolation' | 'process_isolation' | 'supported_policies'> {
  return available
    ? { filesystem_isolation: 'unverified', network_isolation: 'unverified', environment_isolation: 'available', process_isolation: 'unverified', supported_policies: ['read-only', 'workspace-write'] }
    : { filesystem_isolation: 'unavailable', network_isolation: 'unavailable', environment_isolation: 'unavailable', process_isolation: 'unavailable', supported_policies: [] }
}

class MacSandbox implements SandboxAdapter {
  constructor(private readonly root: string) {}
  status(): SandboxStatus { return { implementation: 'macos-sandbox-exec', available: true, diagnostic: 'ready', reason: 'macOS sandbox-exec policy enforcement is available; hostile verification is still required before agent use.', policy: 'workspace-write', network: 'disabled', writable_roots: [this.root, join(tmpdir(), 'swico-sandbox')], ...capabilities(true), runtime_version: 'sandbox-exec (system)' } }
  wrap(argv: string[], policy: SandboxPolicy = 'workspace-write', network: NetworkPolicy = 'disabled'): { command: string; args: string[] } { const writable = join(tmpdir(), 'swico-sandbox'); mkdirSync(writable, { recursive: true, mode: 0o700 }); return { command: '/usr/bin/sandbox-exec', args: ['-p', macProfile(this.root, policy, network, writable), argv[0], ...argv.slice(1)] } }
  spawn(argv: string[], options: SpawnOptions & { policy?: SandboxPolicy; network?: NetworkPolicy }): ChildProcess {
    const wrapped = this.wrap(argv, options.policy, options.network)
    return spawn(wrapped.command, wrapped.args, { ...options, cwd: options.cwd ?? this.root, env: safeEnvironment(options.env) })
  }
}

class LinuxBubblewrap implements SandboxAdapter {
  constructor(private readonly workspaceRoot: string) {}
  status(): SandboxStatus { return { implementation: 'linux-bubblewrap', available: true, diagnostic: 'ready', reason: 'bubblewrap is installed and will create a mount, user, PID, and network namespace; hostile verification is still required before agent use.', policy: 'workspace-write', network: 'disabled', writable_roots: ['/workspace', '/tmp'], ...capabilities(true), runtime_version: 'bubblewrap (system)' } }
  private args(argv: string[], policy: SandboxPolicy, network: NetworkPolicy, environment?: NodeJS.ProcessEnv): string[] {
    const root = safeRoot(this.workspaceRoot), args = ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-uts', '--unshare-ipc', '--ro-bind', '/usr', '/usr']
    for (const path of ['/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', '/usr/local']) {
      try { realpathSync(path); args.push('--ro-bind', path, path) } catch { /* optional system directory */ }
    }
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/workspace', '--chdir', '/workspace', '--clearenv', '--setenv', 'HOME', '/tmp/swico-home', '--dir', '/tmp/swico-home')
    for (const [name, value] of Object.entries(safeEnvironment(environment))) if (name !== 'HOME' && value !== undefined) args.push('--setenv', name, value)
    if (network === 'disabled') args.push('--unshare-net')
    args.push(policy === 'workspace-write' ? '--bind' : '--ro-bind', root, '/workspace', '--', argv[0], ...argv.slice(1))
    return args
  }
  wrap(argv: string[], policy: SandboxPolicy = 'workspace-write', network: NetworkPolicy = 'disabled'): { command: string; args: string[] } { return { command: 'bwrap', args: this.args(argv, policy, network) } }
  spawn(argv: string[], options: SpawnOptions & { policy?: SandboxPolicy; network?: NetworkPolicy }): ChildProcess {
    const root = safeRoot(this.workspaceRoot), policy = options.policy ?? 'workspace-write', network = options.network ?? 'disabled'
    return spawn('bwrap', this.args(argv, policy, network, options.env), { ...options, cwd: root, env: safeEnvironment(options.env) })
  }
}

class UnavailableSandbox implements SandboxAdapter {
  constructor(private readonly reason: string, private readonly root: string, private readonly diagnostic: SandboxDiagnostic = 'unsupported_platform') {}
  status(): SandboxStatus { return { implementation: 'unavailable', available: false, diagnostic: this.diagnostic, reason: this.reason, policy: 'read-only', network: 'disabled', writable_roots: [], ...capabilities(false) } }
  wrap(): { command: string; args: string[] } { throw new Error(`Swico sandbox unavailable: ${this.reason}. Refusing unsandboxed execution.`) }
  spawn(): ChildProcess { throw new Error(`Swico sandbox unavailable: ${this.reason}. Refusing unsandboxed command execution.`) }
}

export function createSandboxAdapter(root: string, platform = process.platform): SandboxAdapter {
  const resolved = safeRoot(root)
  if (platform === 'darwin' && commandExists('sandbox-exec')) {
    const probe = macRuntimeDiagnostic()
    if (probe.ready) return new MacSandbox(resolved)
    return new UnavailableSandbox(probe.reason, resolved, probe.diagnostic)
  }
  if (platform === 'linux' && commandExists('bwrap')) {
    const probe = bubblewrapDiagnostic()
    if (probe.ready) return new LinuxBubblewrap(resolved)
    return new UnavailableSandbox(probe.reason, resolved, probe.diagnostic)
  }
  return new UnavailableSandbox(platform === 'win32' ? 'Windows requires a reviewed native sandbox runtime; none is bundled.' : 'No supported OS-enforced sandbox runtime is installed.', resolved, platform === 'win32' ? 'unsupported_platform' : 'binary_missing')
}

export function sandboxPathSummary(root: string): { workspace: string; home: string; outside_workspace: string } { return { workspace: safeRoot(root), home: homedir(), outside_workspace: relative(root, dirname(root)) } }

function safeEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const path = process.platform === 'win32'
    ? [environment.SystemRoot ? `${environment.SystemRoot}\\System32` : '', environment.SystemRoot ? environment.SystemRoot : ''].filter(Boolean).join(';')
    : process.platform === 'darwin'
      ? '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
      : '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  const result: NodeJS.ProcessEnv = {
    PATH: path,
    LANG: environment.LANG ?? 'C.UTF-8',
    LC_ALL: environment.LC_ALL ?? environment.LANG ?? 'C.UTF-8',
    TMPDIR: process.platform === 'linux' ? '/tmp/swico-sandbox' : join(tmpdir(), 'swico-sandbox'),
  }
  if (process.platform === 'win32' && environment.SystemRoot) result.SystemRoot = environment.SystemRoot
  return result
}

export type SandboxProbeName = 'workspace_read' | 'workspace_write' | 'outside_workspace_read' | 'outside_workspace_write' | 'home_secret_read' | 'secret_environment' | 'network_outbound' | 'child_process' | 'symlink_escape'
export type SandboxProbe = { name: SandboxProbeName; expected: 'allow' | 'deny'; observed: 'allowed' | 'denied' | 'not_run' | 'error'; passed: boolean; detail: string }
export type SandboxVerification = {
  verified: boolean
  implementation: SandboxStatus['implementation']
  diagnostic: SandboxDiagnostic
  reason: string
  runtime: { platform: string; architecture: string; node: string }
  verified_at: string
  probes: SandboxProbe[]
}

const verificationScript = String.raw`
const fs = require('node:fs'), cp = require('node:child_process'), http = require('node:http');
const [probe, workspace, outside, homeSecret, link, port, secret] = process.argv.slice(1);
const report = allowed => { process.stdout.write(JSON.stringify({ allowed: Boolean(allowed) })); };
try {
  if (probe === 'workspace_read') { fs.readFileSync(workspace); report(true); }
  else if (probe === 'workspace_write') { fs.appendFileSync(workspace, 'probe'); report(true); }
  else if (probe === 'outside_workspace_read') { fs.readFileSync(outside); report(true); }
  else if (probe === 'outside_workspace_write') { fs.writeFileSync(outside + '.write', 'probe'); report(true); }
  else if (probe === 'home_secret_read') { fs.readFileSync(homeSecret); report(true); }
  else if (probe === 'secret_environment') { report(process.env.SWICO_VERIFY_SECRET === secret); }
  else if (probe === 'symlink_escape') { fs.readFileSync(link); report(true); }
  else if (probe === 'child_process') {
    try { cp.execFileSync(process.execPath, ['-e', 'require("node:fs").readFileSync(process.argv[1])', outside], { stdio: 'ignore' }); report(true); }
    catch { report(false); }
  } else if (probe === 'network_outbound') {
    let finished = false;
    const done = value => { if (finished) return; finished = true; report(value); };
    const request = http.get({ host: '127.0.0.1', port: Number(port), path: '/' }, () => done(true));
    request.on('error', () => done(false));
    setTimeout(() => done(false), 800);
  } else report(false);
} catch { report(false); }
`

async function runProbe(adapter: SandboxAdapter, workspaceRoot: string, name: SandboxProbeName, expected: 'allow' | 'deny', paths: { workspace: string; outside: string; homeSecret: string; link: string; port: number; secret: string }, policy: SandboxPolicy): Promise<SandboxProbe> {
  const started = Date.now()
  return await new Promise<SandboxProbe>(resolveProbe => {
    let child: ChildProcess
    try {
      child = adapter.spawn([process.execPath, '-e', verificationScript, name, paths.workspace, paths.outside, paths.homeSecret, paths.link, String(paths.port), paths.secret], {
        cwd: workspaceRoot, shell: false, env: { ...process.env, SWICO_VERIFY_SECRET: paths.secret }, stdio: ['ignore', 'pipe', 'pipe'], policy, network: 'disabled'
      })
    } catch (error) {
      resolveProbe({ name, expected, observed: 'error', passed: false, detail: error instanceof Error ? error.message.slice(0, 200) : 'sandbox spawn failed' }); return
    }
    let stdout = '', stderr = '', settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill('SIGKILL'); resolveProbe({ name, expected, observed: 'error', passed: false, detail: 'probe timed out' }) } }, 2_000)
    child.stdout?.on('data', chunk => { stdout = (stdout + String(chunk)).slice(0, 1_024) })
    child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, 1_024) })
    child.on('error', error => { if (settled) return; settled = true; clearTimeout(timer); resolveProbe({ name, expected, observed: 'error', passed: false, detail: error.message.slice(0, 200) }) })
    child.on('close', code => {
      if (settled) return
      settled = true; clearTimeout(timer)
      let allowed = false
      try { allowed = JSON.parse(stdout).allowed === true } catch { /* a denied sandbox may terminate before reporting */ }
      const observed = allowed ? 'allowed' : 'denied'
      const passed = expected === 'allow' ? allowed && code === 0 : !allowed
      resolveProbe({ name, expected, observed, passed, detail: `${observed}${code === null ? '' : ` (exit ${code})`}${stderr.trim() ? `: ${cleanProbeText(stderr)}` : ''} in ${Date.now() - started}ms` })
    })
  })
}

function cleanProbeText(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) }

export async function verifySandbox(root: string): Promise<SandboxVerification> {
  const started = Date.now(), runtimeRoot = await mkdtemp(join(tmpdir(), 'swico-sandbox-verify-')), secret = randomBytes(16).toString('hex'), workspaceFile = join(runtimeRoot, 'workspace.txt'), outsideRoot = await mkdtemp(join(tmpdir(), 'swico-sandbox-outside-')), outsideFile = join(outsideRoot, 'outside.txt'), homeRoot = join(homedir(), `.swico-sandbox-verify-${randomBytes(8).toString('hex')}`), homeSecret = join(homeRoot, 'secret.txt'), link = join(runtimeRoot, 'escape.txt')
  const runtime = createSandboxAdapter(runtimeRoot), status = runtime.status()
  const base = { platform: process.platform, architecture: process.arch, node: process.version }, now = new Date().toISOString()
  if (!status.available) {
    await rm(runtimeRoot, { recursive: true, force: true }); await rm(outsideRoot, { recursive: true, force: true })
    return { verified: false, implementation: status.implementation, diagnostic: status.diagnostic, reason: status.reason, runtime: base, verified_at: now, probes: probeNames.map(([name, expected]) => ({ name, expected, observed: 'not_run', passed: false, detail: 'sandbox runtime unavailable' })) }
  }
  await writeFile(workspaceFile, 'workspace\n'); await writeFile(outsideFile, 'outside\n'); await mkdir(homeRoot, { recursive: true, mode: 0o700 }); await writeFile(homeSecret, 'fake verification secret\n', { mode: 0o600 }); await symlink(outsideFile, link)
  const server = createServer((_request, response) => { response.end('verification'); }); await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen())); const address = server.address(), port = typeof address === 'object' && address ? address.port : 0
  const paths = { workspace: workspaceFile, outside: outsideFile, homeSecret, link, port, secret }, probes: SandboxProbe[] = []
  try {
    for (const [name, expected, policy] of probeNames) probes.push(await runProbe(runtime, runtimeRoot, name, expected, paths, policy))
  } finally {
    server.close(); await rm(runtimeRoot, { recursive: true, force: true }); await rm(outsideRoot, { recursive: true, force: true }); await rm(homeRoot, { recursive: true, force: true })
  }
  return { verified: probes.every(item => item.passed), implementation: status.implementation, diagnostic: probes.every(item => item.passed) ? 'ready' : status.diagnostic, reason: probes.every(item => item.passed) ? 'Hostile filesystem, environment, process, symlink, and network probes passed.' : `Sandbox verification failed after ${Date.now() - started}ms; inspect individual probes.`, runtime: base, verified_at: now, probes }
}

const probeNames: Array<[SandboxProbeName, 'allow' | 'deny', SandboxPolicy]> = [
  ['workspace_read', 'allow', 'read-only'], ['workspace_write', 'allow', 'workspace-write'],
  ['outside_workspace_read', 'deny', 'read-only'], ['outside_workspace_write', 'deny', 'workspace-write'],
  ['home_secret_read', 'deny', 'read-only'], ['secret_environment', 'deny', 'read-only'],
  ['network_outbound', 'deny', 'read-only'], ['child_process', 'deny', 'read-only'], ['symlink_escape', 'deny', 'read-only'],
]
