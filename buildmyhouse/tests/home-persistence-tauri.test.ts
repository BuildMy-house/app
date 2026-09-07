import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyHome } from '../src/core/home'
import { loadHomeFile, saveHomeFile } from '../src/services/adapters/home-persistence'

/**
 * M30: Tauri-path I/O failure handling in home-persistence.ts.
 *
 * Mocks the tauri-fs bridge (isTauri -> true, TauriFsStorage stub) and the
 * @tauri-apps/plugin-dialog dynamic import so saveHomeFile/loadHomeFile take
 * their Tauri branches without a real host.
 *
 * Contract under test:
 * - saveHomeFile: a writeText rejection must not escape unhandled — it is
 *   logged and rethrown as a wrapped Error with a clear message (save has no
 *   browser-path failure mode to mirror, so the caller (main.ts) can
 *   catch-and-alert).
 * - loadHomeFile: resolves null ONLY for user-cancel (no path selected).
 *   A genuine readText rejection or parseHomeFile failure is logged and
 *   rethrown as a wrapped Error so the caller (main.ts) can distinguish it
 *   from cancel and alert the user.
 */

const mocks = vi.hoisted(() => ({
  writeText: vi.fn(),
  readText: vi.fn(),
  dialogSave: vi.fn(),
  dialogOpen: vi.fn(),
}))

vi.mock('../src/services/adapters/tauri-fs', () => ({
  isTauri: () => true,
  TauriFsStorage: class {
    writeText = mocks.writeText
    readText = mocks.readText
  },
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: mocks.dialogSave,
  open: mocks.dialogOpen,
}))

const PATH = '/tmp/home.json'

describe('saveHomeFile (Tauri path)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.dialogSave.mockResolvedValue(PATH)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('wraps a writeText rejection in a clear Error instead of throwing raw', async () => {
    mocks.writeText.mockRejectedValue(new Error('No space left on device'))
    await expect(saveHomeFile(createEmptyHome())).rejects.toThrow(
      `Failed to save home file to ${PATH}: No space left on device`,
    )
  })

  it('logs the failure with the target path before rethrowing', async () => {
    mocks.writeText.mockRejectedValue(new Error('EACCES'))
    await saveHomeFile(createEmptyHome()).catch(() => {})
    expect(console.error).toHaveBeenCalledWith(
      `Failed to save home file to ${PATH}:`,
      expect.any(Error),
    )
  })

  it('dialog cancel resolves without touching the filesystem', async () => {
    mocks.dialogSave.mockResolvedValue(null)
    await expect(saveHomeFile(createEmptyHome())).resolves.toBeUndefined()
    expect(mocks.writeText).not.toHaveBeenCalled()
  })
})

describe('loadHomeFile (Tauri path)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.dialogOpen.mockResolvedValue(PATH)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('readText rejection throws a clear Error (distinct from cancel)', async () => {
    mocks.readText.mockRejectedValue(new Error('file vanished'))
    await expect(loadHomeFile()).rejects.toThrow(
      `Failed to load home file from ${PATH}: file vanished`,
    )
    expect(console.error).toHaveBeenCalledWith('Failed to load home file:', expect.any(Error))
  })

  it('malformed JSON throws', async () => {
    mocks.readText.mockResolvedValue('{"levelCount":')
    await expect(loadHomeFile()).rejects.toThrow(/Failed to load home file from /)
    expect(console.error).toHaveBeenCalledWith('Failed to load home file:', expect.any(Error))
  })

  it('valid JSON but invalid project shape throws', async () => {
    mocks.readText.mockResolvedValue('42')
    await expect(loadHomeFile()).rejects.toThrow(/Failed to load home file from /)
    expect(console.error).toHaveBeenCalledWith('Failed to load home file:', expect.any(Error))
  })

  it('valid file resolves the parsed home', async () => {
    const home = createEmptyHome()
    mocks.readText.mockResolvedValue(JSON.stringify(home))
    await expect(loadHomeFile()).resolves.toEqual(home)
  })

  it('dialog cancel resolves null without reading', async () => {
    mocks.dialogOpen.mockResolvedValue(null)
    await expect(loadHomeFile()).resolves.toBeNull()
    expect(mocks.readText).not.toHaveBeenCalled()
  })
})
