/**
 * quick-preview.ts — Client-side instant render preview export.
 *
 * Exports the current 3D viewport as PNG/JPG using canvas.toBlob().
 * Cached in IndexedDB so repeated exports are instant and use zero bandwidth.
 *
 * No server needed, works offline, zero CPU cost on server.
 */

/**
 * Export the current 3D viewport as an image blob.
 * Requires a Three.js WebGL renderer.
 */
export async function exportViewportAsImage(
  canvas: HTMLCanvasElement,
  format: 'png' | 'jpeg' = 'png',
  quality = 0.95,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png'
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Failed to export canvas to blob'))
          return
        }
        resolve(blob)
      },
      mimeType,
      quality,
    )
  })
}

/**
 * IndexedDB cache for exported previews.
 * Stores recent exports so repeated downloads are instant.
 */
export class PreviewCache {
  private readonly dbName = 'homely-previews'
  private readonly storeName = 'previews'
  private db: IDBDatabase | null = null

  /**
   * Initialize the cache (open or create IndexedDB).
   */
  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1)

      request.onerror = () => {
        console.warn('PreviewCache: IndexedDB unavailable')
        resolve() // Degrade gracefully
      }

      request.onsuccess = () => {
        this.db = request.result
        resolve()
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'homeId' })
        }
      }
    })
  }

  /**
   * Save a preview image for a home.
   * Overwrites previous preview for the same home.
   */
  async save(homeId: string, blob: Blob): Promise<void> {
    if (!this.db) return

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction([this.storeName], 'readwrite')
      const store = tx.objectStore(this.storeName)
      const request = store.put({
        homeId,
        blob,
        timestamp: Date.now(),
      })

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  }

  /**
   * Retrieve a cached preview for a home.
   * Returns null if not cached or cache unavailable.
   */
  async get(homeId: string): Promise<Blob | null> {
    if (!this.db) return null

    return new Promise((resolve) => {
      const tx = this.db!.transaction([this.storeName], 'readonly')
      const store = tx.objectStore(this.storeName)
      const request = store.get(homeId)

      request.onerror = () => resolve(null)
      request.onsuccess = () => {
        const result = request.result
        resolve(result?.blob ?? null)
      }
    })
  }

  /**
   * Clear all cached previews.
   */
  async clear(): Promise<void> {
    if (!this.db) return

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction([this.storeName], 'readwrite')
      const store = tx.objectStore(this.storeName)
      const request = store.clear()

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  }

  /**
   * Get cache size in bytes (all previews combined).
   */
  async getSize(): Promise<number> {
    if (!this.db) return 0

    return new Promise((resolve) => {
      const tx = this.db!.transaction([this.storeName], 'readonly')
      const store = tx.objectStore(this.storeName)
      const request = store.getAll()

      request.onerror = () => resolve(0)
      request.onsuccess = () => {
        const blobs = (request.result ?? []) as Array<{ blob: Blob }>
        const total = blobs.reduce((sum, item) => sum + item.blob.size, 0)
        resolve(total)
      }
    })
  }
}

/**
 * Download a blob as a file to the user's computer.
 * Works in all modern browsers (no server needed).
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * Generate a filename for the exported preview.
 * Format: "home-{name}-{date}.png"
 */
export function generatePreviewFilename(homeName: string, format: 'png' | 'jpeg' = 'png'): string {
  const now = new Date()
  const date = now.toISOString().split('T')[0]
  const time = now.toTimeString().split(' ')[0]?.replace(/:/g, '-')
  const ext = format === 'jpeg' ? 'jpg' : 'png'
  const safeName = homeName.replace(/[^a-z0-9-]/gi, '_').toLowerCase()
  return `${safeName}-${date}-${time}.${ext}`
}
