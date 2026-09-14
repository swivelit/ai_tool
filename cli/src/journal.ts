import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export class ActionJournal {
  constructor(private readonly filename: string) {}
  async record(entry: { action_id: string; action_type: string; payload_hash: string; status: 'prepared' | 'executing' | 'succeeded' | 'failed' | 'unknown' }): Promise<void> {
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 })
    await appendFile(this.filename, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`, { mode: 0o600 })
    await chmod(this.filename, 0o600).catch(() => undefined)
  }
  async latest(actionId: string, payloadHash: string): Promise<'prepared' | 'executing' | 'succeeded' | 'failed' | 'unknown' | null> {
    try {
      const rows = (await readFile(this.filename, 'utf8')).split(/\r?\n/).filter(Boolean)
      let status: 'prepared' | 'executing' | 'succeeded' | 'failed' | 'unknown' | null = null
      for (const row of rows) {
        try {
          const value = JSON.parse(row) as { action_id?: string; payload_hash?: string; status?: typeof status }
          if (value.action_id === actionId && value.payload_hash === payloadHash && value.status) status = value.status
        } catch { /* malformed journal lines are ignored, never executed */ }
      }
      return status
    } catch { return null }
  }
}
