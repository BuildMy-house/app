import { defineConfig } from '@playwright/test'

// E2E_PORT lets parallel git-worktree checkouts run their own dev server
// without colliding on the shared default 1420 (a foreign checkout's server
// on 1420 would otherwise be silently reused via reuseExistingServer).
const port = Number(process.env.E2E_PORT ?? 1420)

// GitHub Actions runners have no GPU, so Chromium's WebGL falls back to
// CPU-only software rendering (SwiftShader) -- every frame is dramatically
// slower than on a dev machine with a real GPU. This was invisible until the
// full suite first ran to completion in CI: multi-step drags blew through
// the default 30s test timeout mid-mouse-move (each synthetic step waits for
// the page to become responsive, and slow frames stall that), and running 2
// workers -- each driving its own software-rendering Chromium -- on a
// typically 2-vCPU runner compounds it with CPU contention. Explicit
// swiftshader flags don't change *whether* WebGL works (it already falls
// back automatically), just make sure the fallback path is the one actually
// exercised rather than left to Chromium's default detection; the timeout
// multiplier and single worker are what actually buy back the room CI needs.
const isCI = !!process.env.CI

export default defineConfig({
  testDir: 'e2e',
  timeout: isCI ? 60_000 : 30_000,
  expect: {
    timeout: isCI ? 10_000 : 5_000,
  },
  retries: 1,
  workers: isCI ? 1 : undefined,
  use: {
    baseURL: `http://localhost:${port}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: isCI
      ? { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }
      : undefined,
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
