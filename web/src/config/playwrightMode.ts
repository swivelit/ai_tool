export type PlaywrightRuntime = {
  mode: 'local' | 'staging' | 'production-readonly' | 'production-triag' | 'production-capability'
  deployedBaseUrl: string | undefined
  workers: 1 | undefined
}

export function resolvePlaywrightRuntime(env: Record<string, string | undefined>): PlaywrightRuntime {
  const rawBaseUrl = env.PLAYWRIGHT_BASE_URL?.trim().replace(/\/$/, '')
  const mode = (env.PLAYWRIGHT_MODE ?? (rawBaseUrl ? 'staging' : 'local')) as PlaywrightRuntime['mode']
  if (!['local', 'staging', 'production-readonly', 'production-triag', 'production-capability'].includes(mode)) {
    throw new Error('PLAYWRIGHT_MODE must be local, staging, production-readonly, production-triag, or production-capability')
  }
  if (mode === 'local') {
    if (rawBaseUrl) throw new Error('PLAYWRIGHT_BASE_URL selects deployed mode and cannot be used with PLAYWRIGHT_MODE=local')
    return { mode, deployedBaseUrl: undefined, workers: undefined }
  }
  if (!rawBaseUrl) throw new Error('Deployed Playwright modes require an HTTPS PLAYWRIGHT_BASE_URL')
  let parsed: URL
  try { parsed = new URL(rawBaseUrl) }
  catch { throw new Error('Deployed Playwright modes require an HTTPS PLAYWRIGHT_BASE_URL') }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('PLAYWRIGHT_BASE_URL must be a credential-free HTTPS origin without query or fragment')
  }
  return { mode, deployedBaseUrl: rawBaseUrl, workers: 1 }
}
