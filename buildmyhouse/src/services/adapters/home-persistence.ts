import { serializeHome } from '../../core/export'
import { isNormalizedHome } from '../../core/project-store'
import type { NormalizedHomeState } from '../../core/home'
import { isTauri, TauriFsStorage } from './tauri-fs'
import { telemetry } from '../../telemetry/logger'

interface TauriDialogPlugin {
  save(options?: { defaultPath?: string }): Promise<string | null>
  open(options?: { filters?: { name: string; extensions: string[] }[] }): Promise<string | null>
}

const PLUGIN_DIALOG = '@tauri-apps/plugin-dialog'

async function tauriDialog(): Promise<TauriDialogPlugin> {
  const mod: string = PLUGIN_DIALOG
  return (await import(/* @vite-ignore */ mod)) as TauriDialogPlugin
}

/** Canonical JSON text for a home project (pretty-printed, rounded). */
export function serializeForSave(home: NormalizedHomeState): string {
  return JSON.stringify(serializeHome(home), null, 2)
}

/** Parse and validate a JSON string as a NormalizedHomeState; throw if invalid. */
export function parseHomeFile(json: string): NormalizedHomeState {
  const value: unknown = JSON.parse(json)
  if (!isNormalizedHome(value)) throw new Error('File is not a valid buildmy.house project')
  return value
}

/** Save the home to disk. Tauri: native save dialog. Browser: download trigger. */
export async function saveHomeFile(home: NormalizedHomeState): Promise<void> {
  const start = performance.now()
  if (isTauri()) {
    const dialog = await tauriDialog()
    const path = await dialog.save({ defaultPath: 'home.json' })
    if (!path) return
    try {
      await new TauriFsStorage().writeText(path, serializeForSave(home))
      telemetry.fileIo('save', performance.now() - start, true, path)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      telemetry.fileIo('save', performance.now() - start, false, path, msg)
      throw new Error(`Failed to save home file to ${path}: ${msg}`)
    }
    return
  }
  const blob = new Blob([serializeForSave(home)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'home.json'
  a.click()
  URL.revokeObjectURL(url)
  telemetry.fileIo('save', performance.now() - start, true)
}

/**
 * Load a home from disk. Tauri: native open dialog. Browser: file input.
 *
 * Resolves null ONLY when the user cancels (no path / no file selected). A
 * genuine read or parse failure throws a clear Error so the caller
 * (main.ts) can distinguish it from cancel and surface it to the user.
 */
export async function loadHomeFile(): Promise<NormalizedHomeState | null> {
  const start = performance.now()
  if (isTauri()) {
    const dialog = await tauriDialog()
    const path = await dialog.open({ filters: [{ name: 'buildmy.house', extensions: ['json'] }] })
    if (!path) return null
    try {
      const text = await new TauriFsStorage().readText(path as string)
      telemetry.fileIo('open', performance.now() - start, true, path as string)
      return parseHomeFile(text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      telemetry.fileIo('open', performance.now() - start, false, path as string, msg)
      throw new Error(`Failed to load home file from ${path}: ${msg}`)
    }
  }
  return await new Promise<NormalizedHomeState | null>((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      file.text().then((text) => {
        try {
          resolve(parseHomeFile(text))
          telemetry.fileIo('open', performance.now() - start, true, file.name)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          telemetry.fileIo('open', performance.now() - start, false, file.name, msg)
          reject(new Error(`Failed to load home file from ${file.name}: ${msg}`))
        }
      }, reject)
    }
    input.click()
  })
}
