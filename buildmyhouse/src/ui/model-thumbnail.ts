/**
 * model-thumbnail.ts — Render a small GLB preview into a <canvas> using a
 * single shared WebGL context (one renderer reused across all catalog cards).
 *
 * Keeps the catalog panel light: one renderer, one scene, camera fit per item.
 * Falls back to a color swatch if WebGL is unavailable or the model fails to
 * load — the DOM stays usable in headless/low-power environments.
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

let sharedRenderer: THREE.WebGLRenderer | null = null
let sharedScene: THREE.Scene | null = null
let sharedCamera: THREE.OrthographicCamera | null = null
let sharedLoader: GLTFLoader | null = null

function ensureShared(): boolean {
  if (sharedRenderer) return true
  try {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setSize(96, 72)
    renderer.setPixelRatio(1)
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-2, 2, 1.5, -1.5, 0.1, 100)
    camera.position.set(0, 0.5, 5)
    camera.lookAt(0, 0.4, 0)
    const ambient = new THREE.AmbientLight(0xffffff, 0.6)
    const key = new THREE.DirectionalLight(0xffffff, 0.8)
    key.position.set(2, 3, 2)
    scene.add(ambient, key)
    sharedRenderer = renderer
    sharedScene = scene
    sharedCamera = camera
    sharedLoader = new GLTFLoader()
    return true
  } catch {
    return false
  }
}

/**
 * Render the GLB at `url` (relative to the bundle root) into `canvas`.
 * On failure the canvas is left blank; callers may fall back to a swatch.
 */
export function renderModelThumbnail(canvas: HTMLCanvasElement, url: string, color: number | null | undefined): void {
  if (!ensureShared()) {
    drawFallback(canvas, color)
    return
  }
  const ctx2d = canvas.getContext('2d')
  if (ctx2d) {
    ctx2d.clearRect(0, 0, canvas.width, canvas.height)
    ctx2d.fillStyle = colorCss(color)
    ctx2d.fillRect(0, 0, canvas.width, canvas.height)
  }
  sharedLoader!.load(
    url,
    (gltf) => {
      const model = gltf.scene
      const box = new THREE.Box3().setFromObject(model)
      const size = box.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z)
      const scale = 1.6 / maxDim
      model.scale.setScalar(scale)
      const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale)
      model.position.sub(center)
      model.rotation.y = -0.6 // slight 3/4 view
      sharedScene!.add(model)
      sharedRenderer!.render(sharedScene!, sharedCamera!)
      // Blit the WebGL framebuffer into the 2D canvas.
      const gl = sharedRenderer!.getContext()
      const w = canvas.width
      const h = canvas.height
      const px = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
      const out = ctx2d!.createImageData(w, h)
      for (let i = 0; i < w * h; i++) {
        out.data[i * 4] = px[i * 4]!
        out.data[i * 4 + 1] = px[i * 4 + 1]!
        out.data[i * 4 + 2] = px[i * 4 + 2]!
        out.data[i * 4 + 3] = px[i * 4 + 3]!
      }
      // readPixels origin is bottom-left; flip vertically.
      const flipped = ctx2d!.createImageData(w, h)
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * w * 4
        flipped.data.set(out.data.subarray(src, src + w * 4), y * w * 4)
      }
      ctx2d!.putImageData(flipped, 0, 0)
      sharedScene!.remove(model)
      disposeDeep(model)
    },
    undefined,
    () => {
      // Keep the color swatch fallback.
    },
  )
}

function disposeDeep(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.geometry) mesh.geometry.dispose()
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material?.dispose()
  })
}

function drawFallback(canvas: HTMLCanvasElement, color: number | null | undefined): void {
  const ctx2d = canvas.getContext('2d')
  if (!ctx2d) return
  ctx2d.fillStyle = colorCss(color)
  ctx2d.fillRect(0, 0, canvas.width, canvas.height)
}

function colorCss(color: number | null | undefined): string {
  if (color === null || color === undefined) return '#9e9e9e'
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`
}
