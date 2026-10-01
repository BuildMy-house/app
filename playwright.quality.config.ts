import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// Quality-rating capture config. Reuses the e2e config wholesale (dev server,
// port handling, NVIDIA Vulkan GPU pinning, chromium project) and narrows it:
// single worker + no retries so every record comes from one deterministic
// browser session, and a list reporter since output is the JSON summaries,
// not the HTML report.
export default defineConfig({
  ...base,
  testDir: 'quality-rating',
  // Playwright's default testMatch would also pick up heuristics.test.ts
  // (a vitest file that crashes under the Playwright runner).
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
})
