import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4310',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run start:test-stack',
    url: 'http://127.0.0.1:4310/api/v1/health/live',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ...process.env,
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://maestro:maestro@127.0.0.1:54329/maestro_test',
      MAESTRO_ALLOW_NETWORK_FETCH: 'false',
      MAESTRO_HOST: '127.0.0.1',
      MAESTRO_PORT: '4310',
      // The suite represents several independent users behind one loopback IP.
      MAESTRO_RATE_LIMIT_MAX: '1000',
    },
  },
});
