#!/usr/bin/env node
/**
 * thumbnail-generator.ts — Generate WebP previews for 3D models
 *
 * Used for:
 * 1. Pre-rendered catalog thumbnails (build-time)
 * 2. User-uploaded model previews (runtime)
 * 3. SH3D library preview generation
 *
 * Renders each model at isometric angle with standard lighting,
 * outputs as 512x512 WebP thumbnail.
 */

import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import * as THREE from 'three'
import { createCanvas } from 'canvas'
import sharp from 'sharp'

interface ThumbnailConfig {
  width?: number
  height?: number
  lighting?: 'studio' | 'ambient'
  backgroundColor?: number
  cameraDistance?: number
}

const DEFAULT_CONFIG: Required<ThumbnailConfig> = {
  width: 512,
  height: 512,
  lighting: 'studio',
  backgroundColor: 0xf5f5f5,
  cameraDistance: 120,
}

/**
 * Set up standard isometric camera (45°, 35° elevation)
 * positioned so model fits in frame
 */
function createCamera(config: Required<ThumbnailConfig>): THREE.Camera {
  const camera = new THREE.PerspectiveCamera(
    45,
    config.width / config.height,
    0.1,
    1000,
  )

  // Isometric angle: 45° rotation, 35° elevation
  const elevation = THREE.MathUtils.degToRad(35)
  const azimuth = THREE.MathUtils.degToRad(45)

  const distance = config.cameraDistance
  camera.position.set(
    distance * Math.cos(elevation) * Math.sin(azimuth),
    distance * Math.sin(elevation),
    distance * Math.cos(elevation) * Math.cos(azimuth),
  )
  camera.lookAt(0, 0, 0)

  return camera
}

/**
 * Create standard three-point lighting setup
 */
function createLighting(config: Required<ThumbnailConfig>): THREE.Light[] {
  const lights: THREE.Light[] = []

  // Key light (directional, sun-like)
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.8)
  keyLight.position.set(50, 100, 50)
  keyLight.castShadow = true
  lights.push(keyLight)

  // Fill light (opposite side, softer)
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.3)
  fillLight.position.set(-50, 50, -50)
  lights.push(fillLight)

  // Ambient light (overall illumination)
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4)
  lights.push(ambientLight)

  return lights
}

/**
 * Render a Three.js scene to WebP
 * Returns the WebP buffer
 */
async function renderToWebP(
  scene: THREE.Scene,
  camera: THREE.Camera,
  config: Required<ThumbnailConfig>,
): Promise<Buffer> {
  const { width, height, backgroundColor } = config
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')

  const bgR = (backgroundColor >> 16) & 0xff
  const bgG = (backgroundColor >> 8) & 0xff
  const bgB = backgroundColor & 0xff
  ctx.fillStyle = `rgb(${bgR},${bgG},${bgB})`
  ctx.fillRect(0, 0, width, height)

  const faces: { verts: [number, number][]; color: string; depth: number }[] = []

  camera.updateMatrixWorld()
  const pvMatrix = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  )

  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const mesh = obj as THREE.Mesh
    const geo = mesh.geometry
    const mat = mesh.material as THREE.MeshStandardMaterial

    mesh.updateWorldMatrix(true, false)
    const mvp = new THREE.Matrix4().multiplyMatrices(pvMatrix, mesh.matrixWorld)

    const pos = geo.getAttribute('position')
    const idx = geo.getIndex()
    if (!pos) return

    const c = mat?.color || new THREE.Color(0x999999)
    const colorStr = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`

    const project = (vi: number) => {
      const v = new THREE.Vector4(pos.getX(vi), pos.getY(vi), pos.getZ(vi), 1)
      v.applyMatrix4(mvp)
      return {
        sx: (v.x / v.w * 0.5 + 0.5) * width,
        sy: (1 - (v.y / v.w * 0.5 + 0.5)) * height,
        z: v.z / v.w,
      }
    }

    const addFace = (i0: number, i1: number, i2: number) => {
      const a = project(i0), b = project(i1), p2 = project(i2)
      faces.push({
        verts: [[a.sx, a.sy], [b.sx, b.sy], [p2.sx, p2.sy]],
        color: colorStr,
        depth: (a.z + b.z + p2.z) / 3,
      })
    }

    if (idx) {
      for (let i = 0; i < idx.count; i += 3) {
        addFace(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2))
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        addFace(i, i + 1, i + 2)
      }
    }
  })

  faces.sort((a, b) => a.depth - b.depth)

  for (const f of faces) {
    ctx.beginPath()
    ctx.moveTo(f.verts[0][0], f.verts[0][1])
    ctx.lineTo(f.verts[1][0], f.verts[1][1])
    ctx.lineTo(f.verts[2][0], f.verts[2][1])
    ctx.closePath()
    ctx.fillStyle = f.color
    ctx.fill()
  }

  return sharp(canvas.toBuffer()).webp({ quality: 85 }).toBuffer()
}

/**
 * Generate a thumbnail for a loaded model
 */
export async function generateThumbnail(
  modelScene: THREE.Object3D,
  outputPath: string,
  config?: Partial<ThumbnailConfig>,
): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  // Create scene for rendering
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(cfg.backgroundColor)

  // Add model
  const clonedModel = modelScene.clone()
  scene.add(clonedModel)

  // Auto-center and scale model
  const bbox = new THREE.Box3().setFromObject(clonedModel)
  const size = new THREE.Vector3()
  bbox.getSize(size)
  const maxDim = Math.max(size.x, size.y, size.z)

  const scale = cfg.cameraDistance / (maxDim * 1.5)
  clonedModel.scale.multiplyScalar(scale)

  const center = new THREE.Vector3()
  bbox.getCenter(center)
  clonedModel.position.sub(center.multiplyScalar(scale))

  // Add lighting and camera
  const lights = createLighting(cfg)
  lights.forEach(light => scene.add(light))

  const camera = createCamera(cfg)
  scene.add(camera)

  // Render and save
  const buffer = await renderToWebP(scene, camera, cfg)

  // Ensure output directory exists
  await mkdir(dirname(outputPath), { recursive: true })

  // Write WebP file
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(outputPath)
    stream.write(buffer)
    stream.end()
    stream.on('finish', resolve)
    stream.on('error', reject)
  })
}

export default generateThumbnail
