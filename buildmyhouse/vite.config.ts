/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      // Track H backend (homely/server) runs on :3000 in dev.
      '/api': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
})
