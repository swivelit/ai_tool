export const TRIAG_REQUEST_AUDIT_BATCH_LIMIT = 12

export type CapabilityAuditTransport = {
  request<T>(
    method: 'POST',
    path: string,
    body: unknown,
    options: { timeoutMilliseconds: number },
  ): Promise<{ status: number; data: T | null }>
}

export type PollableCapabilityAudit = {
  request_id: string
  cancellation_state: string
  orphaned_active_reservation: boolean
  active_usage_stage_names: string[]
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

export function capabilityAuditIsTerminal(audit: PollableCapabilityAudit): boolean {
  return !audit.orphaned_active_reservation
    && audit.active_usage_stage_names.length === 0
    && ['complete', 'cancelled', 'failed'].includes(audit.cancellation_state)
}

export async function pollCapabilityAudits<T extends PollableCapabilityAudit>(options: {
  api: CapabilityAuditTransport
  requestIds: readonly string[]
  timeoutMilliseconds?: number
  concurrency?: number
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
}): Promise<Map<string, T>> {
  const uniqueIds = [...new Set(options.requestIds)]
    .filter(id => /^[0-9a-f-]{36}$/i.test(id))
  if (uniqueIds.length === 0) return new Map()

  const timeoutMilliseconds = options.timeoutMilliseconds ?? 60_000
  const concurrency = Math.max(1, Math.min(4, options.concurrency ?? 3))
  const now = options.now ?? Date.now
  const wait = options.wait ?? (
    milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  )
  const deadline = now() + timeoutMilliseconds
  const last = new Map<string, T>()
  let pending = uniqueIds

  while (now() < deadline && pending.length > 0) {
    const batches = chunks(pending, TRIAG_REQUEST_AUDIT_BATCH_LIMIT)
    let nextBatch = 0
    const workers = Array.from(
      { length:Math.min(concurrency, batches.length) },
      async () => {
        while (nextBatch < batches.length) {
          const batch = batches[nextBatch++]
          const remaining = Math.max(1, deadline - now())
          const response = await options.api.request<{ results: T[] }>(
            'POST', '/api/web/admin/triag-request-audit',
            { request_ids:batch },
            { timeoutMilliseconds:Math.min(15_000, remaining) },
          ).catch(() => ({ status:0, data:null }))
          for (const audit of response.data?.results ?? []) {
            if (batch.includes(audit.request_id)) last.set(audit.request_id, audit)
          }
        }
      },
    )
    await Promise.all(workers)
    pending = uniqueIds.filter(id => {
      const audit = last.get(id)
      return !audit || !capabilityAuditIsTerminal(audit)
    })
    if (pending.length === 0) return last
    const remaining = deadline - now()
    if (remaining > 0) await wait(Math.min(500, remaining))
  }

  if (last.size === uniqueIds.length) return last
  throw new Error('request_audit_timeout')
}
