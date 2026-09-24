import { existsSync } from 'node:fs'
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

// Local runs: force headless Chromium's WebGL onto the NVIDIA dGPU instead of
// the iGPU. Verified 2026-09-24: ANGLE's GL backend ignores glvnd's
// __EGL_VENDOR_LIBRARY_FILENAMES (always landed on the Mesa Intel device), so
// we go through ANGLE's Vulkan backend with VK_* ICD vars pinned to the NVIDIA
// ICD -- that deterministically selects the RTX GPU. CI runners have no NVIDIA
// driver and no such ICD file, so they keep the SwiftShader fallback.
const nvidiaIcd = '/usr/share/vulkan/icd.d/nvidia_icd.json'
const isNvidia = !isCI && existsSync(nvidiaIcd)

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
    launchOptions: isNvidia
      ? {
          args: ['--use-angle=vulkan'],
          env: {
            ...process.env,
            VK_DRIVER_FILES: nvidiaIcd,
            VK_ICD_FILENAMES: nvidiaIcd,
          },
        }
      : {},
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
    // Multi-level e2e specs (level deletion, roof/interior view, level
    // discoverability) exercise the full feature, so the flag must be ON
    // for the dev server they run against.
    env: { VITE_ENABLE_MULTI_LEVEL: 'true' },
  },
  reporter: [['html', { open: 'never' }]],
})
