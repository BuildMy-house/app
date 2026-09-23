import { defineConfig } from '@playwright/test'

// E2E_PORT lets parallel git-worktree checkouts run their own dev server
// without colliding on the shared default 1420 (a foreign checkout's server
// on 1420 would otherwise be silently reused via reuseExistingServer).
const port = Number(process.env.E2E_PORT ?? 1420)

// GitHub Actions runners have no GPU, so Chromium's WebGL falls back to
// CPU-only software rendering (SwiftShader) automatically -- every frame is
// dramatically slower than on a dev machine with a real GPU. This was
// invisible until the full suite first ran to completion in CI: multi-step
// drags blew through the default 30s test timeout mid-mouse-move (each
// synthetic step waits for the page to become responsive, and slow frames
// stall that), and running 2 workers -- each driving its own software-
// rendering Chromium -- on a typically 2-vCPU runner compounds it with CPU
// contention. The timeout multiplier and single worker below buy back the
// room CI needs.
//
// Do NOT add explicit --use-gl=swiftshader/--ignore-gpu-blocklist launch
// args here -- tried that, and it broke Playwright's filechooser
// interception entirely (page.waitForEvent('filechooser') hangs for the
// full test timeout, reproduced locally with these exact flags). Chromium
// already falls back to software rendering on its own; forcing it via flags
// isn't needed and actively regresses file-upload tests.
const isCI = !!process.env.CI

export default defineConfig({
  testDir: 'e2e',
  // 60s wasn't enough headroom either -- the two remaining multi-step-drag
  // tests (viewport3d-interactions/viewport3d orbit) still hit exactly that
  // ceiling on the real CI runner (both pass locally, ~20s, even forcing
  // software GL), so the runner's real constraint is worse than that local
  // approximation. Bumping further rather than re-guessing at launch flags.
  timeout: isCI ? 120_000 : 30_000,
  expect: {
    timeout: isCI ? 10_000 : 5_000,
  },
  retries: 1,
  workers: isCI ? 1 : 4,
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
