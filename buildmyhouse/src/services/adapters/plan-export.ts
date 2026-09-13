import { BrowserCaptureBackend, type CaptureBackend } from '../../automation/capture'
import type { NormalizedHomeState } from '../../core/home'
import type { PerspectiveCamera, Scene } from 'three'

/** Default offscreen render size for exports (px). */
export const PLAN_EXPORT_WIDTH = 1600
export const PLAN_EXPORT_HEIGHT = 1200

export interface PlanExportOptions {
  width?: number
  height?: number
  /** Test injection; defaults to the real offscreen rasterizer. */
  backend?: CaptureBackend
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const bytes = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** Render `home`'s plan view offscreen (auto-fit) and return raw PNG bytes. */
export function renderPlanPng(
  home: NormalizedHomeState,
  opts: PlanExportOptions = {},
): Uint8Array<ArrayBuffer> {
  const backend = opts.backend ?? new BrowserCaptureBackend()
  const pngBase64 = backend.renderPlan(
    home,
    opts.width ?? PLAN_EXPORT_WIDTH,
    opts.height ?? PLAN_EXPORT_HEIGHT,
  )
  if (!opts.backend) backend.dispose?.()
  return base64ToBytes(pngBase64)
}

/**
 * Export the current plan view as a PNG download. Works in plain browser/vite
 * and inside the Tauri webview (Blob + anchor download, same pattern M1's
 * browser Save uses).
 */
export function exportPlanPng(home: NormalizedHomeState, opts: PlanExportOptions = {}): void {
  const bytes = renderPlanPng(home, opts)
  const blob = new Blob([bytes], { type: 'image/png' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'plan.png'
  a.click()
  URL.revokeObjectURL(url)
}

/** Render a live 3D scene offscreen and return raw PNG bytes. */
export function render3dPng(
  scene: Scene,
  camera: PerspectiveCamera,
  opts: PlanExportOptions = {},
): Uint8Array<ArrayBuffer> {
  const backend = opts.backend ?? new BrowserCaptureBackend()
  const pngBase64 = backend.render3d(
    scene,
    camera,
    opts.width ?? PLAN_EXPORT_WIDTH,
    opts.height ?? PLAN_EXPORT_HEIGHT,
  )
  if (!opts.backend) backend.dispose?.()
  return base64ToBytes(pngBase64)
}

/**
 * Export the current 3D view as a PNG download. Works in plain browser/vite
 * and inside the Tauri webview (Blob + anchor download, same pattern as
 * `exportPlanPng`).
 */
export function export3dPng(
  scene: Scene,
  camera: PerspectiveCamera,
  opts: PlanExportOptions = {},
): void {
  const bytes = render3dPng(scene, camera, opts)
  const blob = new Blob([bytes], { type: 'image/png' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = '3d-view.png'
  a.click()
  URL.revokeObjectURL(url)
}
