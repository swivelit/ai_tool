import { describe, expect, it } from 'vitest'
import {
  capabilityAuditHasActiveProviderGeneration,
  cleanupUsageAuditReasons,
  forceCancelActiveCapabilityRequests,
  pollCapabilityAudits,
  TRIAG_REQUEST_AUDIT_BATCH_LIMIT,
} from './productionCapabilityAudit'

const requestId = (index: number) => (
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
)

const terminalAudit = (id: string) => ({
  request_id:id,
  cancellation_state:'complete',
  orphaned_active_reservation:false,
  active_usage_stage_names:[],
})

describe('production capability request-audit batching', () => {
  it.each([
    [1, 1],
    [12, 1],
    [13, 2],
    [27, 3],
  ])('polls %i request IDs in %i bounded batch(es)', async (count, batches) => {
    const posted: string[][] = []
    const api = {
      async request<T>(
        _method: 'POST', _path: string, body: unknown,
      ) {
        const ids = (body as { request_ids: string[] }).request_ids
        posted.push(ids)
        return {
          status:200,
          data:{ results:ids.map(terminalAudit) } as T,
        }
      },
    }
    const ids = Array.from({ length:count }, (_, index) => requestId(index + 1))

    const result = await pollCapabilityAudits({ api, requestIds:ids })

    expect(result.size).toBe(count)
    expect(posted).toHaveLength(batches)
    expect(posted.every(batch => batch.length <= TRIAG_REQUEST_AUDIT_BATCH_LIMIT)).toBe(true)
    expect(posted.flat().sort()).toEqual(ids.sort())
  })

  it('polls only non-terminal request IDs on later rounds', async () => {
    const ids = [requestId(1), requestId(2)]
    const posted: string[][] = []
    let round = 0
    let clock = 0
    const api = {
      async request<T>(
        _method: 'POST', _path: string, body: unknown,
      ) {
        const batch = (body as { request_ids: string[] }).request_ids
        posted.push(batch)
        round += 1
        return {
          status:200,
          data:{
            results:batch.map(id => id === ids[1] && round === 1
              ? { ...terminalAudit(id), cancellation_state:'active', active_usage_stage_names:['generation'] }
              : terminalAudit(id)),
          } as T,
        }
      },
    }

    await pollCapabilityAudits({
      api, requestIds:ids, timeoutMilliseconds:5_000,
      now:() => clock,
      wait:async milliseconds => { clock += milliseconds },
    })

    expect(posted).toEqual([ids, [ids[1]]])
  })

  it('reports missing, nonterminal, and active cleanup audits independently', () => {
    const ids = [requestId(1), requestId(2), requestId(3)]
    const audits = new Map([
      [ids[0], terminalAudit(ids[0])],
      [ids[1], {
        ...terminalAudit(ids[1]),
        cancellation_state:'active',
        orphaned_active_reservation:true,
        active_usage_stage_names:['generation'],
      }],
    ])
    expect(cleanupUsageAuditReasons(ids, audits)).toEqual([
      'usage_audit_missing_requests',
      'usage_audit_nonterminal_requests',
      'active_usage_remains',
    ])
  })

  it('accepts a running generation stage before provider calls are settled', () => {
    expect(capabilityAuditHasActiveProviderGeneration({
      ...terminalAudit(requestId(1)),
      cancellation_state:'active',
      active_usage_stage_names:['generation'],
      cache_hit:false,
      generation_stage_count:1,
      provider_call_count:0,
    })).toBe(true)
  })

  it('force-cancels a benchmark-owned nonterminal generation before terminal audit', async () => {
    const id = requestId(1)
    const posts: string[] = []
    let cancelled = false
    let clock = 0
    const api = {
      async request<T>(
        _method: 'POST', path: string, body: unknown,
      ) {
        posts.push(path)
        if (path.endsWith('/cancel')) {
          cancelled = true
          return { status:200, data:{ status:'cancelling' } as T }
        }
        const ids = (body as { request_ids: string[] }).request_ids
        return {
          status:200,
          data:{
            results:ids.map(value => cancelled
              ? terminalAudit(value)
              : {
                ...terminalAudit(value),
                cancellation_state:'active',
                active_usage_stage_names:['generation'],
                cache_hit:false,
                generation_stage_count:1,
              }),
          } as T,
        }
      },
    }

    const result = await forceCancelActiveCapabilityRequests({
      api, requestIds:[id], timeoutMilliseconds:5_000,
      now:() => clock,
      wait:async milliseconds => { clock += milliseconds },
    })

    expect(result.cancellationAttemptedIds).toEqual([id])
    expect(result.cancellationFailedIds).toEqual([])
    expect(result.audits.get(id)?.cancellation_state).toBe('complete')
    expect(posts).toContain(`/api/web/chat/requests/${id}/cancel`)
  })
})
