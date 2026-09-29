import { defineConfig, devices } from '@playwright/test'

// Specs get their own server and demo data per file from e2e/fixtures.ts, so there is no baseURL or webServer here.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
