import { describe, expect, it } from 'vitest'
import {
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
})
