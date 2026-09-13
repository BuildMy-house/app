import { defineConfig } from '@playwright/test'

// E2E_PORT lets parallel git-worktree checkouts run their own dev server
// without colliding on the shared default 1420 (a foreign checkout's server
// on 1420 would otherwise be silently reused via reuseExistingServer).
const port = Number(process.env.E2E_PORT ?? 1420)

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: `http://localhost:${port}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  reporter: [['html', { open: 'never' }]],
})
