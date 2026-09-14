/**
 * ObjToGlbConverter — OBJ (+ optional MTL) → binary glTF (GLB).
 *
 * Conversion logic extracted near-verbatim from
 * scripts/import-sh3d-library.ts (that script stays as the reference; do not
 * "improve" the conversion math or texture handling here — it is
 * battle-tested against 1500+ real SH3D models).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Buffer } from 'node:buffer'

// GLTFExporter uses FileReader (browser-only) for the binary GLB path.
if (typeof globalThis.FileReader === 'undefined') {
  class NodeFileReader {
    result: ArrayBuffer | null = null
    onloadend: (() => void) | null = null
    readAsArrayBuffer(blob: Blob): void {
      void blob.arrayBuffer().then((buffer) => {
        this.result = buffer
        this.onloadend?.()
      })
    }
  }
  ;(globalThis as { FileReader?: unknown }).FileReader = NodeFileReader
}

import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import type { AssetConverter, ConversionOptions, ConvertedAsset, Rotation9 } from '../asset-ingestion-service.js'

// Installs the Node canvas/Image polyfills the three.js loaders need (same
// mechanism as the reference script's side-effect import). Non-literal
// specifier on purpose: keeps scripts/convert-sh3d-models.ts (never
// typechecked, has pre-existing tsc errors) out of tsc's program while tsx
// still loads and runs it at startup, before any conversion happens.
const polyfills = '../../../scripts/convert-sh3d-models.js'
await import(polyfills)

/** Detect real image bytes on the polyfill NodeImage (PNG or JPEG magic). */
function sniffImageMime(image: unknown): 'image/png' | 'image/jpeg' | null {
  const buf = (image as { buffer?: Buffer } | null | undefined)?.buffer
  if (!buf || buf.length < 4) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  return null
}

function textureMapsOf(material: THREE.Material): THREE.Texture[] {
  const maps: THREE.Texture[] = []
  for (const [key, value] of Object.entries(material)) {
    // 'map' is the diffuse texture; lowercase 'm' means endsWith('Map') misses it.
    if ((key === 'map' || key.endsWith('Map')) && value instanceof THREE.Texture) maps.push(value)
  }
  return maps
}

/**
 * Prepare every texture for glTF export: sniff real bytes to set the correct
 * mimeType, and switch to flipY=false (images are exported unflipped), which
 * requires inverting the V coordinate of the consuming geometry.
 */
function sanitizeTextures(group: THREE.Group): void {
  group.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const geometry = mesh.geometry as THREE.BufferGeometry
    const hasUv = geometry.attributes.uv !== undefined
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const fixed = mats.map((mat) => {
      const maps = textureMapsOf(mat)
      for (const tex of maps) {
        const mime = sniffImageMime(tex.image)
        if (mime === null) {
          // Missing/undecodable texture file: fall back to flat material color.
          ;(mat as unknown as Record<string, unknown>)[textureKeyOf(mat, tex)] = null
          continue
        }
        tex.flipY = false
        tex.userData.mimeType = mime
      }
      if (!hasUv && maps.some((t) => t.userData.mimeType)) {
        // TEXCOORD_0 invariant: textured material on uv-less geometry -> strip maps.
        const clone = mat.clone()
        for (const key of Object.keys(clone)) {
          if (key.endsWith('Map')) (clone as unknown as Record<string, unknown>)[key] = null
        }
        return clone
      }
      return mat
    })
    mesh.material = Array.isArray(mesh.material) ? fixed : fixed[0]!
    if (hasUv) invertUvV(geometry)
  })
}

const invertedGeometries = new Set<THREE.BufferGeometry>()

/** glTF uses a top-left UV origin; source OBJs use bottom-left. */
function invertUvV(geometry: THREE.BufferGeometry): void {
  if (invertedGeometries.has(geometry)) return
  invertedGeometries.add(geometry)
  const uv = geometry.attributes.uv
  if (!uv) return
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i))
}

function textureKeyOf(material: THREE.Material, texture: THREE.Texture): string {
  for (const [key, value] of Object.entries(material)) {
    if (key.endsWith('Map') && value === texture) return key
  }
  return 'map'
}

/** Drop map_* lines that point at missing texture files (they'd break export). */
function sanitizeMtlText(mtlPath: string): string {
  const raw = readFileSync(mtlPath, 'utf8')
  return raw
    .split(/\r?\n/)
    .filter((line) => {
      const m = line.match(/^\s*(map_\w+)\s+(.+)$/)
      if (!m || !m[1] || !m[2]) return true
      const file = m[2].trim().split(/\s+/).pop() ?? ''
      return existsSync(join(dirname(mtlPath), file))
    })
    .join('\n')
}

/** Build the three.js scene graph for one model (parse, materials, pose, sanitize). */
function buildGroup(objText: string, mtlPath: string | null, rotation: Rotation9 | null): THREE.Group {
  const objLoader = new OBJLoader()
  if (mtlPath) {
    const materialCreator: MTLLoader.MaterialCreator = new MTLLoader().parse(sanitizeMtlText(mtlPath), dirname(mtlPath) + '/')
    materialCreator.preload()
    objLoader.setMaterials(materialCreator)
  }
  const group = objLoader.parse(objText)
  if (!mtlPath) {
    const flatMaterial = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.8, metalness: 0.05 })
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) (child as THREE.Mesh).material = flatMaterial
    })
  }
  if (rotation) {
    const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = rotation
    group.applyMatrix4(new THREE.Matrix4().set(
      m00, m01, m02, 0,
      m10, m11, m12, 0,
      m20, m21, m22, 0,
      0, 0, 0, 1,
    ))
  }
  // Center on X/Z, rest on floor at Y=0.
  const bbox = new THREE.Box3().setFromObject(group)
  const center = bbox.getCenter(new THREE.Vector3())
  group.position.set(-center.x, -bbox.min.y, -center.z)
  group.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
  })
  sanitizeTextures(group)
  return group
}

function exportGlb(group: THREE.Object3D): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      group,
      (result) => resolve(Buffer.from(result as ArrayBuffer)),
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
      { binary: true },
    )
  })
}

/** Converts Wavefront OBJ (+ optional MTL with baked textures) to binary glTF. */
export class ObjToGlbConverter implements AssetConverter {
  canHandle(format: string): boolean {
    return format.toLowerCase() === 'obj'
  }

  async convert(input: Buffer, options: ConversionOptions): Promise<ConvertedAsset> {
    const group = buildGroup(input.toString('utf8'), options.mtlPath, options.rotation ?? null)
    const buffer = await exportGlb(group)
    return { buffer, byteSize: buffer.length, format: 'glb' }
  }
}
