export const TOP_LEVEL_COMMANDS = [
  'login', 'logout', 'whoami', 'usage', 'ask', 'exec', 'agent', 'review', 'resume',
  'doctor', 'config', 'mcp', 'mcp-server', 'skills', 'plugins', 'completion',
  'sandbox', 'worktree', 'cloud', 'release-readiness',
] as const

export type TopLevelCommand = typeof TOP_LEVEL_COMMANDS[number]

const TOP_LEVEL_SET = new Set<string>(TOP_LEVEL_COMMANDS)
const GLOBAL_VALUE_OPTIONS = new Set(['--cwd'])

export class CommandUsageError extends Error {
  readonly exitCode = 2

  constructor(message: string) {
    super(message)
    this.name = 'CommandUsageError'
  }
}

export function topLevelCommand(argv: string[]): { command?: string; index: number } {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (GLOBAL_VALUE_OPTIONS.has(value)) {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new CommandUsageError(`${value} requires a value.`)
      index += 1
      continue
    }
    if (value.startsWith('--')) throw new CommandUsageError(`Unknown option ${value}. Use \`swico --help\` for command usage.`)
    return { command: value, index }
  }
  return { index: -1 }
}

function usage(command: string, detail: string): never {
  throw new CommandUsageError(`${detail} Usage: swico ${command}${command === 'usage' ? ' [--json]' : ''}`)
}

function noArguments(command: string, args: string[]): void {
  if (args.length) usage(command, `The ${command} command does not accept arguments.`)
}

export function validateTopLevelArguments(command: string, argv: string[]): void {
  if (!TOP_LEVEL_SET.has(command)) throw new CommandUsageError(`Unknown command "${command}". Run swico --help to see available commands.`)
  const args = argv.slice(argv.indexOf(command) + 1)
  if (command === 'usage') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) usage(command, 'Usage accepts only --json.')
    return
  }
  if (command === 'release-readiness') {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) usage(command, 'Release readiness accepts only --json.')
    return
  }
  if (['whoami', 'logout', 'doctor', 'review', 'mcp-server'].includes(command)) {
    noArguments(command, args)
    return
  }
  if (command === 'completion') {
    if (args.length !== 1 || !['bash', 'zsh', 'fish', 'powershell'].includes(args[0])) usage(command, 'Choose bash, zsh, fish, or powershell.')
    return
  }
  if (command === 'login') {
    let tierSeen = false
    for (let index = 0; index < args.length; index += 1) {
      const value = args[index]
      if (value === '--agent' || value === '--memory-only') continue
      if (value === '--tier') {
        if (tierSeen || !args[index + 1] || !['lite', 'standard', 'pro'].includes(args[index + 1])) usage(command, '--tier must be lite, standard, or pro.')
        tierSeen = true; index += 1; continue
      }
      usage(command, `Unknown option or argument ${value}.`)
    }
    return
  }
  if (command === 'ask' || command === 'exec') return
  if (command === 'agent') {
    if (args.length === 0 || args.some(value => value.startsWith('--'))) usage(command, 'Agent requires a task and does not accept options.')
    return
  }
  if (command === 'resume') {
    if (args.length > 1 || (args[0] ?? '').startsWith('--')) usage(command, 'Resume accepts at most one local session ID.')
    return
  }
}

export type InteractiveCommand =
  | { kind: 'message'; text: string }
  | { kind: 'command'; name: string; argument?: string }

const NO_ARGUMENT_COMMANDS = new Set([
  'exit', 'help', 'new', 'mode', 'status', 'sandbox', 'worktree', 'cloud', 'config',
  'mcp', 'skills', 'plan', 'permissions', 'init', 'review', 'history', 'whoami',
  'model', 'usage', 'diff',
])

function commandError(name: string, detail: string): never {
  throw new CommandUsageError(`${detail} Type /help for interactive commands.`)
}

export function parseInteractiveCommand(input: string): InteractiveCommand {
  const value = input.trim()
  if (!value.startsWith('/')) return { kind: 'message', text: value }
  const match = value.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match) return { kind: 'message', text: value }
  const name = match[1]
  const argument = match[2]?.trim() || undefined
  const known = new Set([
    ...NO_ARGUMENT_COMMANDS, 'mode', 'search', 'image', 'resume', 'permissions', 'agent', 'ask',
  ])
  if (!known.has(name)) throw new CommandUsageError(`Unknown interactive command "/${name}". Use /ask TEXT for an intentional slash-prefixed Chat message.`)
  if (NO_ARGUMENT_COMMANDS.has(name) && name !== 'mode' && name !== 'sandbox' && name !== 'worktree' && name !== 'cloud' && name !== 'mcp' && name !== 'permissions' && argument) commandError(name, `/${name} does not accept arguments.`)
  if (name === 'mode' && argument && !['chat', 'agent', 'plan'].includes(argument)) commandError(name, 'Mode must be chat, agent, or plan.')
  if (name === 'search' && argument && !['auto', 'on', 'off'].includes(argument)) commandError(name, 'Search must be auto, on, or off.')
  if (name === 'permissions' && argument && !['read-only', 'approval-required'].includes(argument)) commandError(name, 'Permission profile must be read-only or approval-required.')
  if (name === 'image' && !argument) commandError(name, 'Usage: /image PATH (paths containing spaces are accepted).')
  if (name === 'agent' && !argument) commandError(name, 'Usage: /agent TASK')
  if (name === 'ask' && !argument) commandError(name, 'Usage: /ask TEXT')
  if (name === 'resume' && argument && argument.split(/\s+/).length !== 1) commandError(name, 'Usage: /resume [SESSION_ID]')
  if (name === 'mcp' && argument && argument !== 'list') commandError(name, 'Usage: /mcp or /mcp list')
  if (name === 'sandbox' && argument && argument !== 'status') commandError(name, 'Usage: /sandbox or /sandbox status')
  if (name === 'worktree' && argument && argument !== 'list') commandError(name, 'Usage: /worktree or /worktree list')
  if (name === 'cloud' && argument) commandError(name, 'Usage: /cloud')
  return argument === undefined ? { kind: 'command', name } : { kind: 'command', name, argument }
}
