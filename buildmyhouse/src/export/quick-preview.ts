/**
 * quick-preview.ts — Client-side instant render preview export.
 *
 * Exports the current 3D viewport as PNG/JPG using canvas.toBlob().
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
