export const TOP_LEVEL_COMMANDS = [
  'login', 'logout', 'whoami', 'ask', 'exec', 'agent', 'review', 'resume',
  'doctor', 'config', 'mcp', 'mcp-server', 'skills', 'plugins', 'completion',
  'sandbox', 'worktree', 'cloud',
] as const

const commandWords = TOP_LEVEL_COMMANDS.join(' ')
const powershellWords = TOP_LEVEL_COMMANDS.map(value => `"${value}"`).join(',')

export function completion(shell: string): string {
  if (shell === 'bash') return `_swico_complete(){ COMPREPLY=( $(compgen -W "${commandWords}" -- "\${COMP_WORDS[COMP_CWORD]}") ); }; complete -F _swico_complete swico\n`
  if (shell === 'zsh') return `#compdef swico\n_arguments "1:command:(${commandWords})"\n`
  if (shell === 'fish') return `complete -c swico -f -a "${commandWords}"\n`
  if (shell === 'powershell') return `Register-ArgumentCompleter -CommandName swico -ScriptBlock { param($wordToComplete) ${powershellWords} | Where-Object { $_ -like "$wordToComplete*" } }\n`
  throw new Error('Completion shell must be bash, zsh, fish, or powershell.')
}
