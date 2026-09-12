export type PublicTier = 'free' | 'lite' | 'standard' | 'pro'

export type CliTokens = {
  access_token: string
  refresh_token: string
  expires_in: number
  session_id: string
  tier: PublicTier
  tier_label: string
  scopes: string[]
  account: { email: string | null; name: string }
}

export type AgentAction = {
  protocol_version: 1 | 2
  action_id: string
  action_type: 'list_files' | 'search_text' | 'read_file' | 'read_file_range' | 'apply_patch' | 'create_file' | 'delete_file' | 'move_file' | 'run_command' | 'git_status' | 'git_diff' | 'mcp_tool' | 'spawn_subagent' | 'web_search'
  payload: Record<string, unknown>
  payload_hash?: string
}

export const AGENT_ACTION_TYPES = [
  'list_files', 'search_text', 'read_file', 'read_file_range', 'apply_patch',
  'create_file', 'delete_file', 'move_file', 'run_command', 'git_status', 'git_diff',
  'mcp_tool',
  'spawn_subagent',
  'web_search',
] as const
export function isAgentActionType(value: unknown): value is AgentAction['action_type'] {
  return typeof value === 'string' && (AGENT_ACTION_TYPES as readonly string[]).includes(value)
}

export type AgentResult = { status: 'succeeded' | 'failed' | 'unknown'; result: unknown }
