// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Boot main.ts (which builds the menu bar) like catalog-load-failure.test.ts.
// We mock the heavy view/panel modules so the app can initialize under jsdom,
// and mock home-persistence so we can force Save/Open into success, cancel, and
// failure paths without a Tauri host.
const root = document.createElement('div')
root.id = 'root'
document.body.appendChild(root)

vi.mock('../src/core/catalog-service', () => ({
  loadDefaultCatalog: vi.fn(() => Promise.resolve({ categories: [] })),
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
  PropertiesPanel: vi.fn(() => ({ toggle: vi.fn() })),
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

const saveHomeFile = vi.fn()
const loadHomeFile = vi.fn()
vi.mock('../src/services/adapters/home-persistence', () => ({
  saveHomeFile: (...args: unknown[]) => saveHomeFile(...args),
  loadHomeFile: (...args: unknown[]) => loadHomeFile(...args),
}))

function clickMenu(label: string): void {
  const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('.menu-entry')).find(
    (b) => b.textContent === label,
  )
  if (!btn) throw new Error(`menu entry "${label}" not found`)
  btn.click()
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('File > Save / Open error surfacing (M35)', () => {
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

  it('Save failure is caught and shown via alert (no unhandled rejection)', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    let unhandled = false
    const onReject = () => { unhandled = true }
    process.on('unhandledRejection', onReject)

    saveHomeFile.mockRejectedValue(new Error('No space left on device'))

    await import('../src/main')
    clickMenu('Save')
    // let the async action settle (and any rejection surface if uncaught)
    await tick()
    await tick()

    process.off('unhandledRejection', onReject)
    expect(unhandled).toBe(false)
    expect(alertSpy).toHaveBeenCalledWith('No space left on device')

    vi.restoreAllMocks()
  })

  it('Save success shows no alert', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    saveHomeFile.mockResolvedValue(undefined)

    await import('../src/main')
    clickMenu('Save')
    await tick()
    await tick()

    expect(alertSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('Open: user cancel (null) is a silent no-op, no alert', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    loadHomeFile.mockResolvedValue(null)

    await import('../src/main')
    clickMenu('Open')
    await tick()
    await tick()

    expect(alertSpy).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('Open: genuine load failure is caught and shown via alert', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    loadHomeFile.mockRejectedValue(new Error('Failed to load home file from /tmp/x.json: file vanished'))

    await import('../src/main')
    clickMenu('Open')
    await tick()
    await tick()

    expect(alertSpy).toHaveBeenCalledWith(
      'Failed to load home file from /tmp/x.json: file vanished',
    )
    vi.restoreAllMocks()
  })
})
