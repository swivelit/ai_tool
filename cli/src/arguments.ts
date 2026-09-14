const VALUE_FLAGS = new Set(['--mode', '--image', '--output', '--output-schema', '--cwd'])
const BOOLEAN_FLAGS = new Set(['--json', '--search', '--no-search', '--memory-only'])

export type TaskArguments = { positionals: string[]; values: Record<string, string>; flags: Set<string> }

/** Parse task commands without treating boolean switches as value-bearing flags. */
export function parseTaskArguments(args: string[], command: string): TaskArguments {
  const start = args.indexOf(command)
  if (start < 0) throw new Error(`Missing ${command} command.`)
  const positionals: string[] = [], values: Record<string, string> = {}, flags = new Set<string>()
  for (let index = start + 1; index < args.length; index += 1) {
    const value = args[index]
    if (!value.startsWith('--')) { positionals.push(value); continue }
    if (VALUE_FLAGS.has(value)) {
      const next = args[index + 1]
      if (!next || next.startsWith('--')) throw new Error(`${value} requires a value.`)
      if (values[value] !== undefined) throw new Error(`${value} may only be supplied once.`)
      values[value] = next; index += 1; continue
    }
    if (BOOLEAN_FLAGS.has(value)) {
      if (flags.has(value)) throw new Error(`${value} may only be supplied once.`)
      flags.add(value); continue
    }
    throw new Error(`Unknown option ${value} for ${command}.`)
  }
  if (flags.has('--search') && flags.has('--no-search')) throw new Error('--search and --no-search cannot be used together.')
  return { positionals, values, flags }
}

export function taskText(parsed: TaskArguments): string { return parsed.positionals.join(' ').trim() }
export function positionalAfter(args: string[], command: string): string { return taskText(parseTaskArguments(args, command)) }
