import { defineConfig, devices } from '@playwright/test'
import { resolvePlaywrightRuntime } from './src/config/playwrightMode'

const { deployedBaseUrl, workers } = resolvePlaywrightRuntime(process.env)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers,
  reporter: ['production-triag', 'production-capability'].includes(
    process.env.PLAYWRIGHT_MODE ?? '',
  )
    ? 'line'
    : process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL: deployedBaseUrl ?? 'http://127.0.0.1:4173',
    // Native traces include request headers and DOM snapshots. The writable
    // production suite emits a deliberately content-free trace instead.
    trace: ['production-triag', 'production-capability'].includes(
      process.env.PLAYWRIGHT_MODE ?? '',
    )
      ? 'off' : 'retain-on-failure',
    screenshot: ['production-triag', 'production-capability'].includes(
      process.env.PLAYWRIGHT_MODE ?? '',
    )
      ? 'off' : 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: deployedBaseUrl ? undefined : {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VITE_API_BASE_URL: 'http://127.0.0.1:4173',
      VITE_E2E_MOCK_AUTH: 'true',
      VITE_FIREBASE_API_KEY: 'local-e2e-public-key',
      VITE_FIREBASE_AUTH_DOMAIN: 'localhost',
      VITE_FIREBASE_PROJECT_ID: 'local-e2e',
      VITE_FIREBASE_APP_ID: '1:1234567890:web:local-e2e',
      VITE_FIREBASE_MESSAGING_SENDER_ID: '1234567890',
    },
  },
})
