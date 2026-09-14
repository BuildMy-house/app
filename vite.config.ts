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
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Three.js and core rendering
          'three-core': ['three'],

          // Three.js loaders (split to lazy-load)
          'three-loaders': ['three/examples/jsm/loaders/GLTFLoader.js'],

          // Three.js controls
          'three-controls': ['three/addons/controls/OrbitControls.js'],

          // UI components (properties panel, catalog, etc.)
          'ui-core': ['src/ui/properties-panel.ts', 'src/ui/catalog-panel.ts'],

          // Core domain logic (should be loaded early)
          'core-logic': ['src/core/model.ts', 'src/core/store.ts', 'src/core/home.ts'],

          // Plan (2D) rendering
          'plan-render': ['src/plan/renderer.ts', 'src/plan/engine.ts'],
        },
      },
    },
    // Warn if chunks exceed 500KB (default; adjust if needed)
    chunkSizeWarningLimit: 500,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
})
