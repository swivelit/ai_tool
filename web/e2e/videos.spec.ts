import { expect, test } from '@playwright/test'

test('video creation is authenticated and preserves the login return path', async ({ page }) => {
  await page.goto('/videos')
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fvideos/)
})

test('video email link preserves its owner-scoped job destination through login', async ({ page }) => {
  const id = '11111111-1111-1111-1111-111111111111'
  await page.goto(`/?video=${id}`)
  await expect(page).toHaveURL(new RegExp(`/login\\?returnTo=%2F%3Fvideo%3D${id}`))
})

test('signed-in video history renders an expired tombstone after reload', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('swico-e2e-auth', 'true'))
  const job = { id: 'job1', template_id: 'couple-01', state: 'expired', phase: 'ready', progress: 100, error: '', funding: 'paid', thread_id: 'thread1', expires_at: '2020-01-01T00:00:00Z', checkout_expires_at: null, queue_position: null, eta_seconds: null, paused: false, refund_status: null }
  await page.route('**/api/web/videos/**', async route => {
    const path = new URL(route.request().url()).pathname
    await route.fulfill({ json: path.endsWith('/capabilities') ? { enabled: false, paid_enabled: false, available: false, price_paise: 2500, policy_version: 'fixture', consent_version: 'video-source-consent-2026-09-19', allowance: { unlimited: false, remaining: 0, reset_at: '2030-01-01T00:00:00Z' }, templates: [{ id: 'couple-01', title: 'Couple scene 1', available: false }, { id: 'couple-02', title: 'Couple scene 2', available: false }] } : path.endsWith('/jobs') ? { items: [job] } : job })
  })
  await page.goto('/videos')
  await expect(page.getByText('Expired — the temporary video is no longer available.')).toBeVisible()
  await page.reload()
  await expect(page.getByText('Expired — the temporary video is no longer available.')).toBeVisible()
  await expect(page.getByText('Download MP4')).toHaveCount(0)
})

test('real browser upload consent and preflight precede explicit complimentary admission', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('swico-e2e-auth', 'true'))
  let state = 'uploading'
  const actions: string[] = []
  const job = () => ({ id: 'fixture-job', template_id: 'couple-01', state, phase: state, progress: 0, error: '', funding: 'unlimited', thread_id: 'thread1', expires_at: null, checkout_expires_at: null, queue_position: state === 'queued' ? 1 : null, eta_seconds: [80, 140], paused: false, refund_status: null, options: { swap: 'both', enhance: 'off', caption: '' } })
  await page.route('**/api/web/videos/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path.endsWith('/capabilities')) return route.fulfill({ json: { available: true, paid_enabled: false, paid_available: false, policy_version: 'fixture', consent_version: 'video-source-consent-2026-09-19', allowance: { unlimited: true, remaining: null, reset_at: '2030-01-01T00:00:00Z' }, templates: [{ id: 'couple-01', title: 'Couple scene 1', available: true }] } })
    if (request.method() === 'POST' || request.method() === 'PUT') actions.push(path)
    if (path.includes('/photos/')) return route.fulfill({ json: { normalized_bytes: 100 } })
    if (path.endsWith('/preflight')) state = 'validated'
    if (path.endsWith('/admit')) {
      expect(state).toBe('validated')
      expect(request.postDataJSON()).toEqual({ funding: 'complimentary' })
      state = 'queued'
      return route.fulfill({ json: { job: job(), checkout: null } })
    }
    return route.fulfill({ json: path.endsWith('/jobs') && request.method() === 'GET' ? { items: [] } : job() })
  })
  await page.goto('/videos')
  const submit = page.getByRole('button', { name: 'Validate photos on Mac (no charge)' })
  await expect(submit).toBeDisabled()
  for (const role of ['Male role photo', 'Female role photo']) await page.getByLabel(role, { exact: true }).setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('image fixture; API mocked, not native inference') })
  for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.check()
  await submit.click()
  await expect(page.getByText('Confirm supported edit')).toBeVisible()
  expect(actions.some(path => path.endsWith('/admit'))).toBe(false)
  await page.getByRole('button', { name: 'Use complimentary attempt' }).click()
  await expect(page.getByText(/Queue position 1/)).toBeVisible()
  expect(actions).toEqual(['/api/web/videos/jobs', '/api/web/videos/jobs/fixture-job/photos/male', '/api/web/videos/jobs/fixture-job/photos/female', '/api/web/videos/jobs/fixture-job/preflight', '/api/web/videos/jobs/fixture-job/admit'])
})
