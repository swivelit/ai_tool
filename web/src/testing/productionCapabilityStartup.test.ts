import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DeployedApiTransportError,
  type ApiResult,
  type DeployedApi,
} from './deployedSafety'
import {
  StartupSnapshotError,
  snapshotProductionAccountState,
  type StartupFailureDiagnostic,
} from './productionCapabilityStartup'

const profile = {
  name:'Private Name', place:'Private Place', timezone:'Asia/Kolkata',
  assistant_name:'Private Assistant', reply_language:'en',
}
const memory = {
  available:false, enabled:false, items:[],
}
const billingExemptWallet = {
  available_micros:0, balance_micros:0, reserved_micros:0,
  billing_exempt:true,
  wallet:{
    available_micros:0, balance_micros:0, reserved_micros:0,
    billing_exempt:true,
  },
  wallets:{
    chat:{ available_micros:0, balance_micros:0, reserved_micros:0, billing_exempt:true },
    voice:{ available_micros:0, balance_micros:0, reserved_micros:0, billing_exempt:true },
  },
}

function ok(data: unknown): ApiResult<unknown> {
  return { status:200, data, contentType:'application/json; charset=utf-8' }
}

class StartupApi implements DeployedApi {
  readonly calls: Array<{ method: string; path: string; body: unknown }> = []

  constructor(
    private readonly responses: Record<
      string, Array<ApiResult<unknown> | Error>
    >,
  ) {}

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    this.calls.push({ method, path, body })
    const queue = this.responses[path]
    const next = queue?.shift()
    if (!next) throw new Error('unexpected_test_endpoint')
    if (next instanceof Error) throw next
    return next as ApiResult<T>
  }
}

function successfulResponses(overrides: Record<
  string, Array<ApiResult<unknown> | Error>
> = {}): Record<string, Array<ApiResult<unknown> | Error>> {
  return {
    '/api/web/threads?archived=false&limit=100&offset=0':[
      ok({ items:[{ id:'active-thread' }], has_more:false, limit:100, offset:0 }),
    ],
    '/api/web/threads?archived=true&limit=100&offset=0':[
      ok({ items:[{ id:'archived-thread' }], has_more:false, limit:100, offset:0 }),
    ],
    '/api/web/settings/profile':[ok(profile)],
    '/api/web/settings/memory':[ok(memory)],
    '/api/web/knowledge':[ok({ items:[] })],
    '/api/web/billing/wallet':[ok(billingExemptWallet)],
    '/api/web/billing/ledger?limit=1&offset=0':[ok({ items:[] })],
    ...overrides,
  }
}

async function snapshot(
  api: DeployedApi,
  options: {
    knowledgeEnabled?: boolean
    diagnostic?: (value: StartupFailureDiagnostic) => Promise<void>
    progress?: (state: 'start' | 'complete', step: string) => void
  } = {},
) {
  return snapshotProductionAccountState({
    api,
    tier:'standard',
    knowledgeEnabled:options.knowledgeEnabled ?? true,
    onFailureDiagnostic:options.diagnostic,
    onProgress:options.progress,
    requestTimeoutMilliseconds:20,
    retryDelayMilliseconds:1,
    wait:async () => undefined,
  })
}

describe('production capability startup snapshot', () => {
  it('snapshots every current endpoint contract without writes', async () => {
    const api = new StartupApi(successfulResponses())
    const progress: string[] = []
    const result = await snapshot(api, {
      progress:(state, step) => progress.push(`${state}:${step}`),
    })
    expect(result).toEqual({
      tier:'standard',
      activeThreadIds:['active-thread'],
      archivedThreadIds:['archived-thread'],
      profile:{
        name:'Private Name', place:'Private Place', timezone:'Asia/Kolkata',
        assistant_name:'Private Assistant', reply_language:'en',
      },
      memory:{ available:false, enabled:false, items:[] },
      knowledgeDocumentIds:[],
      walletValues:{ chat:0, voice:0 },
      latestLedgerId:null,
    })
    expect(api.calls.every(call => call.method === 'GET')).toBe(true)
    expect(api.calls.every(call => call.body === undefined)).toBe(true)
    expect(progress).toEqual([
      'start:active_threads', 'complete:active_threads',
      'start:archived_threads', 'complete:archived_threads',
      'start:profile', 'complete:profile',
      'start:memory', 'complete:memory',
      'start:knowledge', 'complete:knowledge',
      'start:wallet', 'complete:wallet',
      'start:ledger', 'complete:ledger',
      'complete:all',
    ])
  })

  it('fails closed when active thread items are not an array', async () => {
    const api = new StartupApi(successfulResponses({
      '/api/web/threads?archived=false&limit=100&offset=0':[
        ok({ items:{ private_title:'must-not-leak' }, has_more:false, limit:100, offset:0 }),
      ],
    }))
    await expect(snapshot(api)).rejects.toMatchObject({
      reasonCode:'startup_response_shape_invalid',
      diagnostic:{ failing_startup_step:'active_threads' },
    })
    expect(api.calls).toHaveLength(1)
  })

  it('reports an archived thread endpoint failure precisely', async () => {
    const api = new StartupApi(successfulResponses({
      '/api/web/threads?archived=true&limit=100&offset=0':[
        { status:404, data:{ detail:'private' }, contentType:'application/json' },
      ],
    }))
    await expect(snapshot(api)).rejects.toMatchObject({
      reasonCode:'archived_thread_snapshot_failed',
      diagnostic:{
        failing_startup_step:'archived_threads', http_status:404,
      },
    })
  })

  it.each([
    [401, 'startup_api_unauthorized'],
    [403, 'startup_api_forbidden'],
  ])('maps profile HTTP %i without retry', async (status, reasonCode) => {
    const api = new StartupApi(successfulResponses({
      '/api/web/settings/profile':[
        { status, data:{ detail:'private' }, contentType:'application/json' },
      ],
    }))
    await expect(snapshot(api)).rejects.toMatchObject({
      reasonCode, diagnostic:{ failing_startup_step:'profile', http_status:status },
    })
    expect(api.calls.filter(call => call.path === '/api/web/settings/profile'))
      .toHaveLength(1)
  })

  it('accepts the actual disabled-memory contract', async () => {
    const api = new StartupApi(successfulResponses())
    await expect(snapshot(api)).resolves.toMatchObject({ memory })
  })

  it('does not call Knowledge Library when bootstrap disables it', async () => {
    const responses = successfulResponses()
    delete responses['/api/web/knowledge']
    const api = new StartupApi(responses)
    const result = await snapshot(api, { knowledgeEnabled:false })
    expect(result.knowledgeDocumentIds).toEqual([])
    expect(api.calls.some(call => call.path === '/api/web/knowledge')).toBe(false)
  })

  it('accepts an empty enabled Knowledge Library result', async () => {
    const api = new StartupApi(successfulResponses())
    await expect(snapshot(api)).resolves.toMatchObject({
      knowledgeDocumentIds:[],
    })
  })

  it('snapshots billing-exempt wallets without requiring paid balances', async () => {
    const api = new StartupApi(successfulResponses())
    await expect(snapshot(api)).resolves.toMatchObject({
      walletValues:{ chat:0, voice:0 },
    })
  })

  it('accepts an empty ledger and records no latest entry', async () => {
    const api = new StartupApi(successfulResponses())
    await expect(snapshot(api)).resolves.toMatchObject({
      latestLedgerId:null,
    })
  })

  it('retries one transient 500 and then succeeds', async () => {
    const api = new StartupApi(successfulResponses({
      '/api/web/settings/profile':[
        { status:500, data:null, contentType:'application/json' }, ok(profile),
      ],
    }))
    await expect(snapshot(api)).resolves.toMatchObject({
      profile:{ reply_language:'en' },
    })
    expect(api.calls.filter(call => call.path === '/api/web/settings/profile'))
      .toHaveLength(2)
  })

  it('bounds and reports a persistent transport timeout', async () => {
    const api = new StartupApi(successfulResponses({
      '/api/web/settings/profile':[
        new DeployedApiTransportError(), new DeployedApiTransportError(),
      ],
    }))
    await expect(snapshot(api)).rejects.toMatchObject({
      reasonCode:'startup_api_timeout',
      diagnostic:{
        failing_startup_step:'profile', error_class:'DeployedApiTransportError',
      },
    })
    expect(api.calls.filter(call => call.path === '/api/web/settings/profile'))
      .toHaveLength(2)
  })

  it('writes only sanitized failure diagnostics and stops before work', async () => {
    const api = new StartupApi(successfulResponses({
      '/api/web/threads?archived=false&limit=100&offset=0':[
        ok({ items:'PRIVATE-THREAD-TITLE', token:'PRIVATE-CREDENTIAL' }),
      ],
    }))
    let diagnosticJson = ''
    let questionStarted = false
    let productionWriteStarted = false
    try {
      await snapshot(api, {
        diagnostic:async value => { diagnosticJson = JSON.stringify(value) },
      })
      questionStarted = true
      productionWriteStarted = true
    } catch (error) {
      expect(error).toBeInstanceOf(StartupSnapshotError)
    }
    expect(questionStarted).toBe(false)
    expect(productionWriteStarted).toBe(false)
    expect(diagnosticJson).toContain('startup_response_shape_invalid')
    expect(diagnosticJson).toContain('active_threads')
    expect(diagnosticJson).not.toContain('PRIVATE-THREAD-TITLE')
    expect(diagnosticJson).not.toContain('PRIVATE-CREDENTIAL')
    expect(diagnosticJson).not.toContain('authorization')
  })

  it('progress events contain step names but no response values', async () => {
    const api = new StartupApi(successfulResponses())
    const progress = vi.fn()
    await snapshot(api, { progress })
    const serialized = JSON.stringify(progress.mock.calls)
    expect(serialized).not.toContain('Private Name')
    expect(serialized).not.toContain('Private Place')
    expect(serialized).not.toContain('balance_micros')
  })

  it('gates questions and writes safe startup failure state', () => {
    const spec = readFileSync(
      resolve(process.cwd(), 'e2e/production-capability.spec.ts'), 'utf8',
    )
    const snapshot = spec.indexOf('await snapshotProductionAccountState({')
    const runCore = spec.indexOf("if (batchIncludes(gate.batch, 'core')) await runCore()")
    expect(snapshot).toBeGreaterThan(0)
    expect(snapshot).toBeLessThan(runCore)
    expect(spec.slice(snapshot, runCore)).toContain('throw error')
    expect(spec).toContain("join(privateRoot, 'startup-failure-diagnostic.json')")
    for (const field of [
      'login_status:loginStatus',
      'startup_snapshot_status:startupSnapshotStatus',
      'failed_startup_step:failedStartupStep',
      'scenarios_started:scenariosStarted',
      'production_writes_started:productionWritesStarted',
      'observed_authoritative_charges:budget.snapshot()',
    ]) expect(spec).toContain(field)
    const workflow = readFileSync(
      resolve(process.cwd(), '../.github/workflows/deployed-smoke.yml'), 'utf8',
    )
    expect(workflow).toContain(
      'web/test-results/swico-capability-private/*/startup-failure-diagnostic.json',
    )
    expect(workflow).toContain("['startup snapshot status', summary.startup_snapshot_status]")
    expect(workflow).not.toContain(
      'web/test-results/swico-capability-private/*/questions-and-answers.md',
    )
  })
})
