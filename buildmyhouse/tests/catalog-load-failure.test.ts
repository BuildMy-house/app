// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

// Create the root element before main.ts runs
const root = document.createElement('div')
root.id = 'root'
document.body.appendChild(root)

vi.mock('../src/core/catalog-service', () => ({
  loadDefaultCatalog: vi.fn(() => Promise.reject(new Error('catalog load failed'))),
}))

vi.mock('../src/view3d', () => ({
  View3D: vi.fn(() => ({
    dispose: vi.fn(),
    setCameraPreset: vi.fn(),
    setLevelVisibility: vi.fn(),
  })),
}))

vi.mock('../src/ui/catalog-panel', () => ({
  CatalogPanel: vi.fn(() => ({
    element: document.createElement('div'),
    setCatalog: vi.fn(),
    isArmed: vi.fn(() => false),
    disarm: vi.fn(),
    renderStatusMessage: vi.fn(),
    place: vi.fn(),
    armedItem: null,
  })),
}))

vi.mock('../src/ui/properties-panel', () => ({
  PropertiesPanel: vi.fn(() => ({
    toggle: vi.fn(),
  })),
}))

vi.mock('../src/ui/preferences', () => ({
  PreferencesDialog: vi.fn(),
  loadPreferences: vi.fn(() => ({
    wallHeightCm: 250,
    wallThicknessCm: 10,
    groundColor: '#cccccc',
  })),
  hexToIntColor: vi.fn(() => 0xcccccc),
}))

describe('catalog load failure resilience', () => {
  it('does not throw unhandled rejection and sets status indicator', async () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })

    const main = await import('../src/main')

    // catalogReady should resolve (not reject) because the catch handler swallows the error
    await expect(main.catalogReady).resolves.toBeUndefined()

    // Wait for async catalog loading to settle
    await new Promise((r) => setTimeout(r, 50))

    const statusAutomation = document.querySelector('#status-automation')
    expect(statusAutomation?.textContent).toContain('catalog unavailable')
  })
})
