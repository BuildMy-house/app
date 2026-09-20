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
    // Vite 8 runs on Rolldown; the old object-form manualChunks is gone.
    // codeSplitting groups match module ids — order the specific
    // loader/control patterns before the broad three/ one.
    rollupOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Three.js loaders (split to lazy-load)
            { name: 'three-loaders', test: /three[\\/]examples[\\/]jsm[\\/]loaders[\\/]GLTFLoader/ },

            // Three.js controls
            { name: 'three-controls', test: /three[\\/]addons[\\/]controls[\\/]OrbitControls/ },

            // Three.js and core rendering
            { name: 'three-core', test: /[\\/]node_modules[\\/]three[\\/]/ },

            // UI components (properties panel, catalog, etc.)
            { name: 'ui-core', test: /src[\\/](ui[\\/])?(properties-panel|catalog-panel)/ },

            // Core domain logic (should be loaded early)
            { name: 'core-logic', test: /src[\\/]core[\\/](model|store|home)/ },

            // Plan (2D) rendering
            { name: 'plan-render', test: /src[\\/]plan[\\/](renderer|engine)/ },
          ],
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
