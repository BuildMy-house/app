import { Scene, PerspectiveCamera, WebGLRenderer } from 'three'
import type { NormalizedHomeState } from '../core/home'
import { ModelError } from '../core/model'
import type { HomeStore } from '../core/store'
import { drawPlan, fitToBounds, type PlanRenderingContext } from '../plan/renderer'
import { View3D } from '../view3d/view'
import type { CameraDirector } from '../view3d/cameras'

export type ScreenshotView = 'plan' | '3d'

export interface ScreenshotRequest {
  view: ScreenshotView
  width: number
  height: number
}

export interface ScreenshotResult {
  pngBase64: string
  width: number
  height: number
}

/**
 * Offscreen pixel producers for the `screenshot` command. The browser
 * implementation rasterizes real canvases; tests inject deterministic fakes.
 * All implementations must honor ws-protocol determinism: DPR 1, no AA
 * randomness, no animation frames, fixed clear colors.
 */
export interface CaptureBackend {
  renderPlan(home: NormalizedHomeState, width: number, height: number): string
  render3d(
    scene: Scene,
    camera: PerspectiveCamera,
    width: number,
    height: number,
  ): string
  dispose?(): void
}

export const MAX_CAPTURE_DIM = 8192

function requireDim(params: { width: number; height: number }, field: 'width' | 'height'): number {
  const value = params[field]
  if (!Number.isInteger(value) || value < 1 || value > MAX_CAPTURE_DIM) {
    throw new ModelError(
      `param ${field} must be an integer between 1 and ${MAX_CAPTURE_DIM}`,
    )
  }
  return value
}

/** Validates the frozen protocol shape {view:"plan"|"3d",width,height}. */
export function validateScreenshotRequest(request: ScreenshotRequest): ScreenshotRequest {
  if (request.view !== 'plan' && request.view !== '3d') {
    throw new ModelError('param view must be "plan" or "3d"')
  }
  return {
    view: request.view,
    width: requireDim(request, 'width'),
    height: requireDim(request, 'height'),
  }
}

/**
 * Real rasterizer. Guarded so importing this module in node never touches
 * DOM/WebGL — construction of surfaces happens per request.
 */
export class BrowserCaptureBackend implements CaptureBackend {
  private renderer: WebGLRenderer | null = null

  renderPlan(home: NormalizedHomeState, width: number, height: number): string {
    if (typeof document === 'undefined') {
      throw new Error('screenshot requires a DOM (browser) environment')
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('screenshot could not acquire a 2D context')
    drawPlan(home, null, ctx as unknown as PlanRenderingContext, fitToBounds(home, width, height))
    return canvasToPngBase64(canvas)
  }

  render3d(
    scene: Scene,
    camera: PerspectiveCamera,
    width: number,
    height: number,
  ): string {
    if (typeof document === 'undefined') {
      throw new Error('screenshot requires a DOM (browser) environment')
    }
    // antialias:false + DPR 1 + preserveDrawingBuffer keep consecutive renders
    // pixel-identical and make toDataURL reliable (no readback flush race).
    if (!this.renderer) {
      this.renderer = new WebGLRenderer({
        antialias: false,
        alpha: false,
        preserveDrawingBuffer: true,
      })
    }
    const renderer = this.renderer
    renderer.setPixelRatio(1)
    renderer.setSize(width, height, false)
    renderer.render(scene, camera)
    return canvasToPngBase64(renderer.domElement)
  }

  dispose(): void {
    this.renderer?.dispose()
    this.renderer = null
  }
}

function canvasToPngBase64(canvas: HTMLCanvasElement): string {
  const url = canvas.toDataURL('image/png')
  const comma = url.indexOf(',')
  return url.slice(comma + 1)
}

/**
 * Screenshot pipeline over one HomeStore. Owns a headless View3D for the 3D
 * path (scene graph without any on-screen renderer) and re-applies the ACTIVE
 * camera state before every capture so automation-driven camera commands are
 * reflected even though the private view has its own director instance.
 */
export class CaptureService {
  private backend: CaptureBackend | undefined
  private view: View3D | undefined

  constructor(
    private readonly store: HomeStore,
    private readonly cameras?: CameraDirector,
    backend?: CaptureBackend,
  ) {
    this.backend = backend
  }

  screenshot(request: ScreenshotRequest): ScreenshotResult {
    const valid = validateScreenshotRequest(request)
    const backend = this.ensureBackend()
    const pngBase64 =
      valid.view === 'plan'
        ? backend.renderPlan(this.store.getHome(), valid.width, valid.height)
        : this.capture3d(backend, valid.width, valid.height)
    return { pngBase64, width: valid.width, height: valid.height }
  }

  dispose(): void {
    this.backend?.dispose?.()
    this.view?.dispose()
    this.view = undefined
  }

  private ensureBackend(): CaptureBackend {
    if (!this.backend) this.backend = new BrowserCaptureBackend()
    return this.backend
  }

  private ensureView(): View3D {
    if (!this.view) this.view = new View3D(this.store)
    return this.view
  }

  private capture3d(backend: CaptureBackend, width: number, height: number): string {
    const view = this.ensureView()
    view.rebuild()
    this.syncActiveCamera(view)
    return backend.render3d(view.scene, view.camera, width, height)
  }

  /** Mirrors View3D.applyCameraState; see spec homely/src/view3d for the formula. */
  private syncActiveCamera(view: View3D): void {
    if (!this.cameras) return
    const cam = this.cameras.getCamera()
    view.camera.position.set(cam.x, cam.z, cam.y)
    view.camera.rotation.y = Math.PI - (cam.yawDeg * Math.PI) / 180
    view.camera.rotation.x = -(cam.pitchDeg * Math.PI) / 180
    view.camera.fov = cam.fovDeg
    view.camera.updateProjectionMatrix()
  }
}
