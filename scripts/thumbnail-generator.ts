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
  // This would require canvas + sharp in Node.js
  // For now, return a placeholder implementation
  // Real implementation would use:
  // - canvas library for WebGL rendering
  // - sharp for WebP encoding

  throw new Error(
    'WebP rendering requires canvas + sharp libraries. '
    + 'Install with: npm install canvas sharp',
  )
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
