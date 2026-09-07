import type { ModelStore, UserModelRecord } from '../../core/user-catalog'

const encode = (data: ArrayBuffer): string => {
  let binary = ''
  for (const byte of new Uint8Array(data)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Server-backed library used by hosted and localhost deployments. */
export class RemoteModelStore implements ModelStore {
  constructor(private readonly baseUrl = '/api/assets', private readonly userId = 'default') {}

  async list(): Promise<UserModelRecord[]> {
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(this.userId)}`)
    if (!response.ok) throw new Error(`asset library unavailable (${response.status})`)
    return ((await response.json()) as { items: UserModelRecord[] }).items
  }

  async put(record: UserModelRecord, data?: ArrayBuffer, sourceData?: ArrayBuffer): Promise<void> {
    if (!data) throw new Error('generated GLB is required')
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(this.userId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record, glb: encode(data), source: sourceData ? encode(sourceData) : null }),
    })
    if (!response.ok) throw new Error(`asset upload failed (${response.status})`)
  }

  async remove(id: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(this.userId)}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!response.ok) throw new Error(`asset removal failed (${response.status})`)
  }

  async getBlob(blobKey: string): Promise<ArrayBuffer | undefined> {
    const id = blobKey.replace(/^blob:/, '')
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(this.userId)}/${encodeURIComponent(id)}/model`)
    return response.ok ? response.arrayBuffer() : undefined
  }
}
