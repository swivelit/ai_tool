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

export type CancellationReadyCapabilityAudit = PollableCapabilityAudit & {
  cache_hit: boolean
  generation_stage_count: number
  provider_call_count: number
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

export function capabilityAuditHasActiveProviderGeneration(
  audit: CancellationReadyCapabilityAudit,
): boolean {
  return audit.cancellation_state === 'active'
    && audit.cache_hit === false
    && audit.generation_stage_count > 0
    && audit.active_usage_stage_names.includes('generation')
}

export function capabilityAuditIsCancellationReady(
  audit: CancellationReadyCapabilityAudit,
  evidence: { streamResponseAccepted: boolean; stopButtonReady: boolean },
): boolean {
  if (audit.cancellation_state !== 'active' || audit.cache_hit) return false
  return capabilityAuditHasActiveProviderGeneration(audit)
    || (evidence.streamResponseAccepted && evidence.stopButtonReady)
}

export async function readCapabilityAuditsOnce<T extends PollableCapabilityAudit>(options: {
  api: CapabilityAuditTransport
  requestIds: readonly string[]
  timeoutMilliseconds?: number
  concurrency?: number
  now?: () => number
}): Promise<Map<string, T>> {
  const uniqueIds = [...new Set(options.requestIds)]
    .filter(id => /^[0-9a-f-]{36}$/i.test(id))
  if (uniqueIds.length === 0) return new Map()
  const now = options.now ?? Date.now
  const deadline = now() + (options.timeoutMilliseconds ?? 15_000)
  const batches = chunks(uniqueIds, TRIAG_REQUEST_AUDIT_BATCH_LIMIT)
  const concurrency = Math.max(1, Math.min(4, options.concurrency ?? 3))
  const result = new Map<string, T>()
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
          { timeoutMilliseconds:remaining },
        )
        if (response.status !== 200 || !response.data) {
          throw new Error('request_audit_timeout')
        }
        for (const audit of response.data.results) {
          if (batch.includes(audit.request_id)) result.set(audit.request_id, audit)
        }
      }
    },
  )
  await Promise.all(workers)
  return result
}

export async function forceCancelActiveCapabilityRequests<
  T extends CancellationReadyCapabilityAudit,
>(options: {
  api: CapabilityAuditTransport
  requestIds: readonly string[]
  timeoutMilliseconds?: number
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
}): Promise<{
  audits: Map<string, T>
  cancellationAttemptedIds: string[]
  cancellationFailedIds: string[]
}> {
  const now = options.now ?? Date.now
  const deadline = now() + (options.timeoutMilliseconds ?? 75_000)
  const snapshot = await readCapabilityAuditsOnce<T>({
    api:options.api,
    requestIds:options.requestIds,
    timeoutMilliseconds:Math.max(1, deadline - now()),
    now,
  })
  const cancellationAttemptedIds = [...snapshot]
    .filter(([, audit]) => !capabilityAuditIsTerminal(audit))
    .map(([requestId]) => requestId)
  const cancellationFailedIds: string[] = []
  let nextCancellation = 0
  const cancellationWorkers = Array.from(
    { length:Math.min(3, cancellationAttemptedIds.length) },
    async () => {
      while (nextCancellation < cancellationAttemptedIds.length) {
        const requestId = cancellationAttemptedIds[nextCancellation++]
        const response = await options.api.request<unknown>(
          'POST', `/api/web/chat/requests/${encodeURIComponent(requestId)}/cancel`,
          undefined, { timeoutMilliseconds:Math.max(1, deadline - now()) },
        ).catch(() => ({ status:0, data:null }))
        if (response.status < 200 || response.status >= 300) {
          cancellationFailedIds.push(requestId)
        }
      }
    }
  )
  await Promise.all(cancellationWorkers)
  const audits = await pollCapabilityAudits<T>({
    api:options.api,
    requestIds:options.requestIds,
    timeoutMilliseconds:Math.max(1, deadline - now()),
    now,
    wait:options.wait,
  })
  return { audits, cancellationAttemptedIds, cancellationFailedIds }
}

export async function pollCapabilityAudits<T extends PollableCapabilityAudit>(options: {
  api: CapabilityAuditTransport
  requestIds: readonly string[]
  timeoutMilliseconds?: number
  concurrency?: number
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
  onTransportFailure?: () => void
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
          if (response.status === 0) options.onTransportFailure?.()
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

export function cleanupUsageAuditReasons<T extends PollableCapabilityAudit>(
  requestIds: readonly string[],
  audits: ReadonlyMap<string, T>,
): string[] {
  const expected = [...new Set(requestIds)].filter(
    id => /^[0-9a-f-]{36}$/i.test(id),
  )
  const missing = expected.filter(id => !audits.has(id))
  const nonterminal = expected.filter(id => {
    const audit = audits.get(id)
    return Boolean(audit && !capabilityAuditIsTerminal(audit))
  })
  const active = expected.filter(id => {
    const audit = audits.get(id)
    return Boolean(
      audit?.orphaned_active_reservation
      || audit?.active_usage_stage_names.length,
    )
  })
  return [
    ...(missing.length ? ['usage_audit_missing_requests'] : []),
    ...(nonterminal.length ? ['usage_audit_nonterminal_requests'] : []),
    ...(active.length ? ['active_usage_remains'] : []),
  ]
}
