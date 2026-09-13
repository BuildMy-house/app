import type { ModelStore, UserModelRecord } from '../../core/user-catalog'

interface Fs {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  remove(path: string): Promise<void>
}

const fsPlugin = async (): Promise<Fs> => (await import('@tauri-apps/plugin-fs')) as unknown as Fs
const appRoot = async (): Promise<string> => (await import('@tauri-apps/api/path')).appDataDir()
const text = (data: Uint8Array): string => new TextDecoder().decode(data)
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

/** Durable local library for AppImage/DEB installs. */
export class TauriModelStore implements ModelStore {
  private rootPath: string | undefined

  private async root(): Promise<string> {
    if (!this.rootPath) {
      this.rootPath = `${await appRoot()}user-models`
      await (await fsPlugin()).mkdir(this.rootPath, { recursive: true })
    }
    return this.rootPath
  }

  private async manifestPath(): Promise<string> {
    return `${await this.root()}/manifest.json`
  }

  private async readManifest(): Promise<UserModelRecord[]> {
    try {
      const data = await (await fsPlugin()).readFile(await this.manifestPath())
      return (JSON.parse(text(data)) as { items?: UserModelRecord[] }).items ?? []
    } catch {
      return []
    }
  }

  async list(): Promise<UserModelRecord[]> {
    return this.readManifest()
  }

  async put(record: UserModelRecord, data?: ArrayBuffer, sourceData?: ArrayBuffer): Promise<void> {
    if (!data) throw new Error('generated GLB is required')
    const fs = await fsPlugin()
    const root = await this.root()
    await fs.writeFile(`${root}/${record.id}.glb`, new Uint8Array(data))
    if (sourceData) await fs.writeFile(`${root}/${record.id}.obj`, new Uint8Array(sourceData))
    const items = (await this.readManifest()).filter((item) => item.id !== record.id)
    const manifest = bytes(JSON.stringify({ schemaVersion: 1, items: [...items, record] }, null, 2) + '\n')
    try { await fs.writeFile(`${root}/manifest.json.bak`, await fs.readFile(await this.manifestPath())) } catch { /* first write */ }
    await fs.writeFile(await this.manifestPath(), manifest)
  }

  async remove(id: string): Promise<void> {
    const fs = await fsPlugin()
    const root = await this.root()
    for (const extension of ['glb', 'obj']) {
      try { await fs.remove(`${root}/${id}.${extension}`) } catch { /* absent source is valid */ }
    }
    const items = (await this.readManifest()).filter((item) => item.id !== id)
    await fs.writeFile(await this.manifestPath(), bytes(JSON.stringify({ schemaVersion: 1, items }, null, 2) + '\n'))
  }

  async getBlob(blobKey: string): Promise<ArrayBuffer | undefined> {
    const id = blobKey.replace(/^blob:/, '')
    try {
      const data = await (await fsPlugin()).readFile(`${await this.root()}/${id}.glb`)
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    } catch { return undefined }
  }
}
