// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Toolbar V/W keyboard shortcuts (boot main.ts like menu-save-open-errors.test.ts —
// same heavy-module mocks so the app initializes under jsdom).
const root = document.createElement('div')
root.id = 'root'
document.body.appendChild(root)

vi.mock('../src/core/catalog-service', () => ({
  loadDefaultCatalog: vi.fn(() => Promise.resolve({ categories: [] })),
  readCachedManifest: vi.fn(() => null),
  catalogFromManifest: vi.fn(() => null),
}))

vi.mock('../src/view3d', () => ({
  View3D: vi.fn(function () {
    return {
      dispose: vi.fn(),
      setCameraPreset: vi.fn(),
      setLevelVisibility: vi.fn(),
      lightIntensity: 1,
      isOutsideView: false,
      director: { getActivePreset: vi.fn(() => 'observer') },
    }
  }),
}))

vi.mock('../src/ui/catalog-panel', () => ({
  CatalogPanel: vi.fn(function () {
    return {
      element: document.createElement('div'),
      setCatalog: vi.fn(),
      isArmed: vi.fn(() => false),
      disarm: vi.fn(),
      renderStatusMessage: vi.fn(),
      place: vi.fn(),
      armedItem: null,
    }
  }),
}))

vi.mock('../src/ui/properties-panel', () => ({
  PropertiesPanel: vi.fn(function () { return { toggle: vi.fn() } }),
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

function toolButton(tool: string): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(`button[data-tool="${tool}"]`)
  if (!btn) throw new Error(`toolbar button for "${tool}" not found`)
  return btn
}

function activeTool(): string | null {
  const btn = document.querySelector<HTMLButtonElement>('button[data-tool].active')
  return btn?.dataset.tool ?? null
}

const keydown = (init: KeyboardEventInit): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', init))
}

describe('toolbar V/W keyboard shortcuts', () => {
  beforeAll(() => {
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
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("'w' switches to the wall tool; 'v' switches back to selection", async () => {
    await import('../src/main')

    keydown({ key: 'w' })
    expect(activeTool()).toBe('wall')
    expect(toolButton('wall').classList.contains('active')).toBe(true)
    expect(document.querySelector('#status-tool')?.textContent).toBe('wall')

    keydown({ key: 'v' })
    expect(activeTool()).toBe('selection')
    expect(toolButton('selection').classList.contains('active')).toBe(true)
    expect(document.querySelector('#status-tool')?.textContent).toBe('selection')
  })

  it("'w'/'v' are ignored while focused in a text input", async () => {
    await import('../src/main')

    keydown({ key: 'v' })
    expect(activeTool()).toBe('selection')

    const input = document.createElement('input')
    input.type = 'text'
    document.body.appendChild(input)
    input.focus()

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }))
    expect(activeTool()).toBe('selection')

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'v' }))
    expect(activeTool()).toBe('selection')

    input.remove()
  })

  it('ctrl+v (paste) is not intercepted by the selection shortcut', async () => {
    await import('../src/main')

    keydown({ key: 'w' })
    expect(activeTool()).toBe('wall')

    keydown({ key: 'v', ctrlKey: true })
    expect(activeTool()).toBe('wall')
  })
})
