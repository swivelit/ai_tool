import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { mkdirSync, realpathSync } from 'node:fs'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

export type SandboxPolicy = 'read-only' | 'workspace-write'
export type NetworkPolicy = 'disabled' | 'allowed'
export type SandboxDiagnostic = 'ready' | 'binary_missing' | 'profile_rejected' | 'sandbox_apply_denied' | 'namespace_unavailable' | 'unsupported_platform' | 'runtime_startup_failure' | 'unknown_failure'
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
  spawn(argv: string[], options: SpawnOptions & { policy?: SandboxPolicy; network?: NetworkPolicy; probeMounts?: Array<{ source: string; target: string }> }): ChildProcess
  /** Map host-only verification fixtures into the sandbox namespace. */
  mapProbePath?(path: string, kind: 'workspace' | 'outside' | 'home' | 'link'): string
}

function commandExists(value: string): boolean { try { execFileSync('sh', ['-c', `command -v ${value}`], { stdio: 'ignore' }); return true } catch { return false } }
function safeRoot(value: string): string { return realpathSync(value) }
function errorOutput(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown }
  return [value.stderr, value.stdout, value.message].filter(item => typeof item === 'string').join('\n').slice(0, 500)
}
function boundedRawCommandResult(error: unknown): string {
  if (!error || typeof error !== 'object') return 'status=unknown signal=unknown errno=unknown stdout= stderr='
  const value = error as { status?: unknown; signal?: unknown; code?: unknown; errno?: unknown; stderr?: unknown; stdout?: unknown }
  const clean = (item: unknown) => typeof item === 'string' ? item.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160) : ''
  return `status=${String(value.status ?? 'unknown')} signal=${String(value.signal ?? 'none')} errno=${String(value.errno ?? value.code ?? 'none')} stdout=${clean(value.stdout)} stderr=${clean(value.stderr)}`
}
export function macRuntimeDiagnostic(run: typeof execFileSync = execFileSync): { ready: boolean; diagnostic: SandboxDiagnostic; reason: string } {
  const readinessPolicy = '(version 1) (deny default) (allow process-exec) (allow process-fork) (allow signal (target self)) (allow file-read* (subpath "/usr") (subpath "/System") (subpath "/Library")) (allow sysctl-read)'
  let valid: unknown
  try {
    run('/usr/bin/sandbox-exec', ['-p', readinessPolicy, '/usr/bin/true'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 2_000 })
    return { ready: true, diagnostic: 'ready', reason: 'macOS sandbox-exec applied a least-privilege readiness policy to a known-startable system executable.' }
  } catch (error) { valid = error }
  // Independent malformed-parser control; it never classifies a valid-profile
  // crash, signal, startup failure, or host sandbox_apply denial.
  let malformed: unknown
  try { run('/usr/bin/sandbox-exec', ['-p', '(version 1', '/usr/bin/true'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 2_000 }) }
  catch (error) { malformed = error }
  const validDetail = errorOutput(valid), raw = boundedRawCommandResult(valid), malformedRaw = boundedRawCommandResult(malformed)
  if (/syntax|parse|invalid|malformed|unknown operation/i.test(validDetail)) return { ready: false, diagnostic: 'profile_rejected', reason: `sandbox-exec rejected its valid readiness profile: ${raw}; parser control: ${malformedRaw}` }
  if (/timed out|timeout/i.test(validDetail) || (valid && typeof valid === 'object' && (valid as { signal?: unknown }).signal === 'SIGTERM')) return { ready: false, diagnostic: 'runtime_startup_failure', reason: `sandbox-exec readiness timed out: ${raw}; parser control: ${malformedRaw}` }
  const explicitDenial = /sandbox_apply|operation not permitted|not permitted|eacces/i.test(validDetail)
  return { ready: false, diagnostic: explicitDenial ? 'sandbox_apply_denied' : 'unknown_failure', reason: `sandbox-exec could not apply its valid readiness profile: ${raw}; parser control: ${malformedRaw}` }
}
function bubblewrapDiagnostic(): { ready: boolean; diagnostic: SandboxDiagnostic; reason: string } {
  if (!commandExists('true') && !commandExists('/usr/bin/true')) return { ready: false, diagnostic: 'runtime_startup_failure', reason: 'bubblewrap is installed but the known-startable readiness executable is missing.' }
  try { execFileSync('bwrap', ['--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-uts', '--unshare-ipc', '--ro-bind', '/usr', '/usr', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/swico-home', '--clearenv', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', '/tmp/swico-home', '--unshare-net', '--', '/usr/bin/true'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 2_000 }); return { ready: true, diagnostic: 'ready', reason: 'bubblewrap is installed and will create least-privilege mount, user, PID, and network namespaces.' } }
  catch (error) {
    const detail = errorOutput(error), startupFailure = /enoent|no such file|cannot execute|exec format/i.test(detail)
    return { ready: false, diagnostic: startupFailure ? 'runtime_startup_failure' : 'namespace_unavailable', reason: startupFailure ? `bubblewrap readiness could not start the known executable${detail ? `: ${detail}` : '.'}` : `bubblewrap readiness could not create its required user/mount namespaces${detail ? `: ${detail}` : '.'}` }
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
  mapProbePath(path: string): string { return path }
}

class LinuxBubblewrap implements SandboxAdapter {
  constructor(private readonly workspaceRoot: string) {}
  status(): SandboxStatus { return { implementation: 'linux-bubblewrap', available: true, diagnostic: 'ready', reason: 'bubblewrap is installed and will create a mount, user, PID, and network namespace; hostile verification is still required before agent use.', policy: 'workspace-write', network: 'disabled', writable_roots: ['/workspace', '/tmp'], ...capabilities(true), runtime_version: 'bubblewrap (system)' } }
  private args(argv: string[], policy: SandboxPolicy, network: NetworkPolicy, environment?: NodeJS.ProcessEnv, probeMounts: Array<{ source: string; target: string }> = []): string[] {
    const root = safeRoot(this.workspaceRoot), args = ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-uts', '--unshare-ipc', '--ro-bind', '/usr', '/usr']
    for (const path of ['/bin', '/sbin', '/lib', '/lib64', '/etc', '/opt', '/usr/local']) {
      try { realpathSync(path); args.push('--ro-bind', path, path) } catch { /* optional system directory */ }
    }
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/swico-sandbox', '--dir', '/workspace', '--chdir', '/workspace', '--clearenv', '--setenv', 'HOME', '/tmp/swico-home', '--dir', '/tmp/swico-home')
    // Verification outside/home paths are intentionally namespace-only. Do
    // not bind their host directories: a read-only bind would grant precisely
    // the read access the negative probes are meant to reject. Read-only
    // system binds make the namespace path exist while keeping it non-writable
    // and separate from the host fixture.
    args.push('--ro-bind', '/usr', '/swico-probe-outside', '--ro-bind', '/usr', '/swico-probe-home')
    for (const mount of probeMounts) {
      if (mount.target.startsWith('/workspace/')) args.push('--ro-bind', safeRoot(mount.source), mount.target)
    }
    for (const [name, value] of Object.entries(safeEnvironment(environment))) if (name !== 'HOME' && value !== undefined) args.push('--setenv', name, value)
    if (network === 'disabled') args.push('--unshare-net')
    args.push(policy === 'workspace-write' ? '--bind' : '--ro-bind', root, '/workspace', '--', argv[0], ...argv.slice(1))
    return args
  }
  wrap(argv: string[], policy: SandboxPolicy = 'workspace-write', network: NetworkPolicy = 'disabled'): { command: string; args: string[] } { return { command: 'bwrap', args: this.args(argv, policy, network) } }
  spawn(argv: string[], options: SpawnOptions & { policy?: SandboxPolicy; network?: NetworkPolicy; probeMounts?: Array<{ source: string; target: string }> }): ChildProcess {
    const root = safeRoot(this.workspaceRoot), policy = options.policy ?? 'workspace-write', network = options.network ?? 'disabled'
    return spawn('bwrap', this.args(argv, policy, network, options.env, options.probeMounts), { ...options, cwd: root, env: safeEnvironment(options.env) })
  }
  mapProbePath(path: string, kind: 'workspace' | 'outside' | 'home' | 'link'): string {
    if (kind === 'workspace' || kind === 'link') return `/workspace/${relative(this.workspaceRoot, path).replaceAll('\\', '/')}`
    return `/swico-probe-${kind}/${path.split(/[\\/]/).pop() ?? 'fixture'}`
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

export type SandboxProbeName = 'workspace_read' | 'workspace_write' | 'workspace_write_read_only' | 'outside_workspace_read' | 'outside_workspace_write' | 'home_secret_read' | 'secret_environment' | 'network_outbound' | 'child_process' | 'symlink_escape'
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
const [probe, workspace, outside, homeSecret, link, port, knownFixtures] = process.argv.slice(1);
const report = (outcome, errorCode) => { process.stdout.write(JSON.stringify({ marker: 'swico-sandbox-probe-v2', probe, outcome, ...(errorCode ? { error_code: String(errorCode).slice(0, 32) } : {}) })); };
const attempt = (operation, namespacePath = false) => { try { operation(); report('allowed'); } catch (error) { report(error && error.code === 'ENOENT' ? (namespacePath && knownFixtures === 'true' ? 'namespace_absent' : 'fixture_missing') : 'denied', error && error.code); } };
try {
  if (probe === 'workspace_read') attempt(() => fs.readFileSync(workspace));
  else if (probe === 'workspace_write') attempt(() => fs.appendFileSync(workspace, 'probe'));
  else if (probe === 'workspace_write_read_only') attempt(() => fs.appendFileSync(workspace, 'probe'));
  else if (probe === 'outside_workspace_read') attempt(() => fs.readFileSync(outside), true);
  else if (probe === 'outside_workspace_write') attempt(() => fs.writeFileSync(outside + '.write', 'probe'), true);
  else if (probe === 'home_secret_read') attempt(() => fs.readFileSync(homeSecret), true);
  else if (probe === 'secret_environment') report(Object.prototype.hasOwnProperty.call(process.env, 'SWICO_VERIFY_SECRET') ? 'allowed' : 'denied');
  else if (probe === 'symlink_escape') attempt(() => fs.readFileSync(link), true);
  else if (probe === 'child_process') {
    const child = cp.spawnSync(process.execPath, ['-e', 'try { require("node:fs").readFileSync(process.argv[1]); process.stdout.write("child-read-allowed") } catch (error) { process.stdout.write("child-read-error:" + (error.code || "unknown")); }', outside], { encoding: 'utf8' });
    if (child.error) report('child_startup_failure', child.error.code);
    else if (child.stdout === 'child-read-allowed') report('allowed');
    else if (child.stdout && child.stdout.startsWith('child-read-error:')) report(child.stdout.endsWith(':ENOENT') && knownFixtures === 'true' ? 'namespace_absent' : child.stdout.endsWith(':EACCES') || child.stdout.endsWith(':EPERM') ? 'denied' : 'child_operation_failure', child.stdout.slice('child-read-error:'.length));
    else report('child_exit_failure', child.status == null ? 'unknown' : 'exit-' + child.status);
  } else if (probe === 'network_outbound') {
    let finished = false;
    const done = (outcome, errorCode) => { if (finished) return; finished = true; report(outcome, errorCode); };
    if (!Number(port)) done('test_server_unavailable');
    else {
      const request = http.get({ host: '127.0.0.1', port: Number(port), path: '/' }, response => { let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => done(body === 'swico-network-control-v1' ? 'allowed' : 'test_server_unavailable')); });
      request.on('error', error => done(error && (error.code === 'ECONNREFUSED' || error.code === 'ENETUNREACH' || error.code === 'ENETDOWN') ? 'network_control_refused' : 'test_server_unavailable', error && error.code));
      setTimeout(() => done('test_server_unavailable'), 800);
    }
  } else report('unknown_probe');
} catch (error) { report(error && error.code === 'ENOENT' ? 'fixture_missing' : 'probe_error', error && error.code); }
`

export async function runSandboxProbe(adapter: SandboxAdapter, workspaceRoot: string, name: SandboxProbeName, expected: 'allow' | 'deny', paths: { workspace: string; outside: string; homeSecret: string; link: string; port: number; controlServerLive?: boolean; fixturesKnown?: boolean }, policy: SandboxPolicy): Promise<SandboxProbe> {
  const started = Date.now()
  const mapped = {
    workspace: adapter.mapProbePath?.(paths.workspace, 'workspace') ?? paths.workspace,
    outside: adapter.mapProbePath?.(paths.outside, 'outside') ?? paths.outside,
    homeSecret: adapter.mapProbePath?.(paths.homeSecret, 'home') ?? paths.homeSecret,
    link: adapter.mapProbePath?.(paths.link, 'link') ?? paths.link,
  }
  return await new Promise<SandboxProbe>(resolveProbe => {
    let child: ChildProcess
    try {
      child = adapter.spawn([process.execPath, '-e', verificationScript, name, mapped.workspace, mapped.outside, mapped.homeSecret, mapped.link, String(paths.port), String(paths.fixturesKnown === true)], {
        cwd: workspaceRoot, shell: false, env: { ...process.env, SWICO_VERIFY_SECRET: randomBytes(16).toString('hex') }, stdio: ['ignore', 'pipe', 'pipe'], policy, network: 'disabled',
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
      let allowed = false, validReport = false
      try {
        const report = JSON.parse(stdout.trim()) as { marker?: unknown; probe?: unknown; outcome?: unknown }
        validReport = report.marker === 'swico-sandbox-probe-v2' && report.probe === name && typeof report.outcome === 'string'
        if (validReport) allowed = report.outcome === 'allowed'
      } catch { /* malformed or missing reports are errors, never deny evidence */ }
      if (!validReport || code !== 0) {
        resolveProbe({ name, expected, observed: 'error', passed: false, detail: `probe did not produce a valid ${name} result${code === null ? '' : ` (exit ${code})`}${stderr.trim() ? `: ${cleanProbeText(stderr)}` : stdout.trim() ? `: ${cleanProbeText(stdout)}` : ''} in ${Date.now() - started}ms` })
        return
      }
      const report = JSON.parse(stdout.trim()) as { outcome?: string; error_code?: string }
      const isolatedNetworkRefusal = name === 'network_outbound' && report.outcome === 'network_control_refused' && paths.controlServerLive === true && adapter.status().implementation !== 'unavailable'
      const namespaceAbsence = report.outcome === 'namespace_absent'
      const observed = allowed ? 'allowed' : report.outcome === 'denied' || isolatedNetworkRefusal || namespaceAbsence ? 'denied' : 'error'
      const passed = expected === 'allow' ? report.outcome === 'allowed' : report.outcome === 'denied' || isolatedNetworkRefusal || namespaceAbsence
      resolveProbe({ name, expected, observed, passed, detail: `${report.outcome ?? 'unknown'}${report.error_code ? ` (${report.error_code})` : ''}${code === null ? '' : ` (exit ${code})`}${stderr.trim() ? `: ${cleanProbeText(stderr)}` : ''} in ${Date.now() - started}ms` })
    })
  })
}

function cleanProbeText(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) }

export async function verifySandbox(root: string): Promise<SandboxVerification> {
  const started = Date.now()
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'swico-sandbox-verify-'))
  const outsideRoot = await mkdtemp(join(tmpdir(), 'swico-sandbox-outside-'))
  const homeRoot = await mkdtemp(join(tmpdir(), 'swico-sandbox-home-'))
  const workspaceFile = join(runtimeRoot, 'workspace.txt'), outsideFile = join(outsideRoot, 'outside.txt'), homeSecret = join(homeRoot, 'secret.txt'), link = join(runtimeRoot, 'escape.txt')
  const base = { platform: process.platform, architecture: process.arch, node: process.version }, now = new Date().toISOString()
  let server: ReturnType<typeof createServer> | undefined
  try {
    const runtime = createSandboxAdapter(runtimeRoot), status = runtime.status()
    if (!status.available) return { verified: false, implementation: status.implementation, diagnostic: status.diagnostic, reason: status.reason, runtime: base, verified_at: now, probes: probeNames.map(([name, expected]) => ({ name, expected, observed: 'not_run', passed: false, detail: 'sandbox runtime unavailable' })) }
    await writeFile(workspaceFile, 'workspace\n'); await writeFile(outsideFile, 'outside\n'); await writeFile(homeSecret, 'fake verification secret\n', { mode: 0o600 })
    // The Linux fixture is mounted at a namespace-only path so the symlink
    // test exercises a real target rather than an accidental ENOENT.
    await symlink(process.platform === 'linux' ? '/swico-probe-outside/outside.txt' : outsideFile, link)
    server = createServer((_request, response) => { response.end('swico-network-control-v1'); })
    await new Promise<void>((resolveListen, rejectListen) => { server?.once('error', rejectListen); server?.listen(0, '127.0.0.1', () => resolveListen()) })
    const address = server.address(), port = typeof address === 'object' && address ? address.port : 0
    const controlServerLive = await new Promise<boolean>(resolveControl => {
      if (!port) return resolveControl(false)
      const request = httpRequest({ host: '127.0.0.1', port, path: '/', timeout: 500 }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk }); response.on('end', () => resolveControl(response.statusCode === 200 && body === 'swico-network-control-v1'))
      })
      request.on('error', () => resolveControl(false)); request.on('timeout', () => { request.destroy(); resolveControl(false) }); request.end()
    })
    const paths = { workspace: workspaceFile, outside: outsideFile, homeSecret, link, port, controlServerLive, fixturesKnown: true }, probes: SandboxProbe[] = []
    for (const [name, expected, policy] of probeNames) probes.push(await runSandboxProbe(runtime, runtimeRoot, name, expected, paths, policy))
    const verified = probes.every(item => item.passed)
    return { verified, implementation: status.implementation, diagnostic: verified ? 'ready' : status.diagnostic, reason: verified ? 'Hostile filesystem, environment, process, symlink, and network probes passed.' : `Sandbox verification failed after ${Date.now() - started}ms; inspect individual probes.`, runtime: base, verified_at: now, probes }
  } finally {
    if (server) await new Promise<void>(resolveClose => server?.close(() => resolveClose()))
    await Promise.all([
      rm(runtimeRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
      rm(homeRoot, { recursive: true, force: true }),
    ])
  }
}

const probeNames: Array<[SandboxProbeName, 'allow' | 'deny', SandboxPolicy]> = [
  ['workspace_read', 'allow', 'read-only'], ['workspace_write', 'allow', 'workspace-write'],
  ['workspace_write_read_only', 'deny', 'read-only'],
  ['outside_workspace_read', 'deny', 'read-only'], ['outside_workspace_write', 'deny', 'workspace-write'],
  ['home_secret_read', 'deny', 'read-only'], ['secret_environment', 'deny', 'read-only'],
  ['network_outbound', 'deny', 'read-only'], ['child_process', 'deny', 'read-only'], ['symlink_escape', 'deny', 'read-only'],
]
