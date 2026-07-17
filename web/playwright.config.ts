import { defineConfig, devices } from '@playwright/test'

const deployedBaseUrl = process.env.PLAYWRIGHT_BASE_URL?.replace(/\/$/, '')
const mode = process.env.PLAYWRIGHT_MODE ?? (deployedBaseUrl ? 'staging' : 'local')
if (!['local', 'staging', 'production-readonly'].includes(mode)) throw new Error('PLAYWRIGHT_MODE must be local, staging, or production-readonly')
if (mode !== 'local' && (!deployedBaseUrl || !deployedBaseUrl.startsWith('https://'))) throw new Error('Deployed Playwright modes require an HTTPS PLAYWRIGHT_BASE_URL')

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL: deployedBaseUrl ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
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
