import { appendFile, chmod, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export class ActionJournal {
  constructor(private readonly filename: string) {}
  async record(entry: { action_id: string; action_type: string; payload_hash: string; status: 'prepared' | 'executing' | 'succeeded' | 'failed' | 'unknown' }): Promise<void> {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    await appendFile(this.filename, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`, { mode: 0o600 })
    await chmod(this.filename, 0o600).catch(() => undefined)
  }
}
