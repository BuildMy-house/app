import { StorageUnavailableError, type StorageAdapter } from '../storage'

/** True when running inside a Tauri WebView with the host bridge present. */
export function isTauri(): boolean {
  return (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ != null
}

interface TauriFsPlugin {
  readTextFile(path: string): Promise<string>
  writeTextFile(path: string, contents: string): Promise<void>
}

const PLUGIN_FS = '@tauri-apps/plugin-fs'

async function tauriFs(): Promise<TauriFsPlugin> {
  const mod: string = PLUGIN_FS
  return (await import(/* @vite-ignore */ mod)) as TauriFsPlugin
}

/**
 * Tauri filesystem adapter. Reads/writes via the @tauri-apps/plugin-fs plugin,
 * which must be installed and granted capability in the Rust host. When the
 * Tauri bridge is absent (plain browser/vite dev) both methods throw so the
 * caller can fall back to the browser path.
 */
export class TauriFsStorage implements StorageAdapter {
  async readText(path: string): Promise<string> {
    if (!isTauri()) throw new StorageUnavailableError(`tauri bridge absent (${path})`)
    const fs = await tauriFs()
    return fs.readTextFile(path)
  }

  async writeText(path: string, contents: string): Promise<void> {
    if (!isTauri()) throw new StorageUnavailableError(`tauri bridge absent (${path})`)
    const fs = await tauriFs()
    await fs.writeTextFile(path, contents)
  }
}
