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
  protocol_version: 1
  action_id: string
  action_type: 'list_files' | 'search_text' | 'read_file' | 'apply_patch' | 'run_command'
  payload: Record<string, unknown>
  payload_hash?: string
}

export type AgentResult = { status: 'succeeded' | 'failed' | 'unknown'; result: unknown }
