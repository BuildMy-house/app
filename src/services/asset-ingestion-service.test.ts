import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

import { buildAssetIngestionEvent, classifyGlbMaterials, collectIngestionMetrics, convertPhongToStandard, type MaterialClassification } from './asset-ingestion-service'
import type { TelemetryEvent } from '../telemetry/events'

/** Pack a glTF JSON document into a minimal parseable GLB binary container. */
function glbBuffer(json: object, bin?: Buffer): Buffer {
  const raw = Buffer.from(JSON.stringify(json), 'utf8')
  const padding = (4 - (raw.length % 4)) % 4
  // spaces are the legal glTF chunk padding and survive JSON.parse
  const padded = Buffer.concat([raw, Buffer.alloc(padding, 0x20)])
  const binPadding = bin ? Buffer.alloc((4 - (bin.length % 4)) % 4) : null
  const chunks = bin && binPadding ? 8 + bin.length + binPadding.length : 0
  const header = Buffer.alloc(12)
  header.write('glTF', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + padded.length + chunks, 8)
  const chunkHeader = Buffer.alloc(8)
  chunkHeader.writeUInt32LE(padded.length, 0)
  chunkHeader.write('JSON', 4, 'ascii')
  if (!bin || !binPadding) return Buffer.concat([header, chunkHeader, padded])
  const binHeader = Buffer.alloc(8)
  binHeader.writeUInt32LE(bin.length, 0)
  binHeader.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, chunkHeader, padded, binHeader, bin, binPadding])
}

describe('classifyGlbMaterials', () => {
  it('distinguishes explicit metallicFactor 1.0 from an absent factor', () => {
    const buffer = glbBuffer({
      materials: [
        { pbrMetallicRoughness: { metallicFactor: 1.0 } },
        { pbrMetallicRoughness: {} },
        {},
      ],
    })
    const classes = classifyGlbMaterials(buffer)!
    expect(classes).toHaveLength(3)
    // authored 1.0: real full-metal signal, tagged metallic
    expect(classes[0]!.metallicFactorAuthored).toBe(true)
    expect(classes[0]!.roughnessFactorAuthored).toBe(false)
    expect(classes[0]!.tags).toEqual(['metallic'])
    // unauthored factors: spec default applies but is flagged, not tagged
    expect(classes[1]!.metallicFactorAuthored).toBe(false)
    expect(classes[1]!.roughnessFactorAuthored).toBe(false)
    expect(classes[1]!.tags).toEqual([])
    // pbrMetallicRoughness absent entirely: same unauthored shape
    expect(classes[2]!.metallicFactorAuthored).toBe(false)
    expect(classes[2]!.roughnessFactorAuthored).toBe(false)
    expect(classes[2]!.tags).toEqual([])
  })

  it('still tags authored roughness and records texture presence', () => {
    const buffer = glbBuffer({
      materials: [
        {
          pbrMetallicRoughness: {
            metallicFactor: 0,
            roughnessFactor: 0.2,
            baseColorTexture: { index: 0 },
            metallicRoughnessTexture: { index: 1 },
          },
        },
      ],
    })
    const classes = classifyGlbMaterials(buffer)!
    expect(classes[0]!.tags).toEqual(['glossy'])
    expect(classes[0]!.metallicFactorAuthored).toBe(true)
    expect(classes[0]!.roughnessFactorAuthored).toBe(true)
    expect(classes[0]!.hasBaseColorTexture).toBe(true)
    expect(classes[0]!.hasMetallicRoughnessTexture).toBe(true)
  })

  it('classifies a real GLTFExporter output (authored factors round-trip)', async () => {
    const standard = new THREE.MeshStandardMaterial({ metalness: 0.4, roughness: 0.25 })
    const scene = new THREE.Scene()
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), standard))
    const glb = await new Promise<Buffer>((resolve, reject) => {
      new GLTFExporter().parse(
        scene,
        (result) => resolve(Buffer.from(result as ArrayBuffer)),
        (err) => reject(err instanceof Error ? err : new Error(String(err))),
        { binary: true },
      )
    })
    const classes = classifyGlbMaterials(glb) as MaterialClassification[]
    expect(classes).toHaveLength(1)
    // exporter always writes explicit factors, so both must read as authored
    expect(classes[0]!.metallicFactorAuthored).toBe(true)
    expect(classes[0]!.roughnessFactorAuthored).toBe(true)
    expect(classes[0]!.tags).toEqual(['glossy'])
  })

  it('returns null for a non-GLB buffer', () => {
    expect(classifyGlbMaterials(Buffer.from('not a glb'))).toBeNull()
  })
})

describe('convertPhongToStandard', () => {
  it('forwards authored normal and bump maps from the MTL-derived Phong material', () => {
    const phong = new THREE.MeshPhongMaterial({ color: 0x336699, shininess: 40 })
    phong.normalMap = new THREE.Texture()
    phong.normalScale.set(2, 3)
    phong.bumpMap = new THREE.Texture()
    phong.bumpScale = 0.7
    const standard = convertPhongToStandard(phong)
    expect(standard.normalMap).toBe(phong.normalMap)
    expect(standard.normalScale.x).toBe(2)
    expect(standard.normalScale.y).toBe(3)
    expect(standard.bumpMap).toBe(phong.bumpMap)
    expect(standard.bumpScale).toBe(0.7)
  })

  it('leaves map slots null when the source MTL has no normal/bump maps', () => {
    const phong = new THREE.MeshPhongMaterial({ color: 0xffffff })
    const standard = convertPhongToStandard(phong)
    expect(standard.normalMap).toBeNull()
    expect(standard.bumpMap).toBeNull()
  })

  it('keeps carrying base color, alpha, and emissive maps', () => {
    const phong = new THREE.MeshPhongMaterial({ color: 0x112233 })
    const diffuse = new THREE.Texture()
    const alpha = new THREE.Texture()
    const emissive = new THREE.Texture()
    phong.map = diffuse
    phong.alphaMap = alpha
    phong.emissiveMap = emissive
    const standard = convertPhongToStandard(phong)
    expect(standard.map).toBe(diffuse)
    expect(standard.alphaMap).toBe(alpha)
    expect(standard.emissiveMap).toBe(emissive)
    expect(standard.color.getHex()).toBe(0x112233)
  })
})

describe('collectIngestionMetrics', () => {
  it('reports empty slots and unauthored factors for a bare material', () => {
    const metrics = collectIngestionMetrics(glbBuffer({ materials: [{}] }))
    expect(metrics).toEqual({
      triangleCount: 0,
      meshCount: 0,
      textureCount: 0,
      textures: [],
      pbrMapSlots: { baseColor: false, normal: false, ao: false, metalnessRoughness: false, emissive: false },
      metallicFactorAuthored: false,
      roughnessFactorAuthored: false,
    })
  })

  it('counts triangles and authored PBR factors', () => {
    const metrics = collectIngestionMetrics(glbBuffer({
      accessors: [{ count: 6 }, { count: 9 }],
      meshes: [{ primitives: [{ indices: 0 }, { attributes: { POSITION: 1 } }] }],
      materials: [{
        pbrMetallicRoughness: {
          metallicFactor: 0.2,
          roughnessFactor: 0.8,
          baseColorTexture: { index: 0 },
          metallicRoughnessTexture: { index: 0 },
        },
        normalTexture: { index: 1 },
        emissiveTexture: { index: 2 },
      }],
      textures: [{ image: 0 }, { image: 0 }, { image: 1 }],
      images: [{ bufferView: 0 }, { bufferView: 1 }],
      bufferViews: [{ byteOffset: 0, byteLength: 8 }, { byteOffset: 8, byteLength: 4 }],
    }))
    expect(metrics!.triangleCount).toBe(5) // 6/3 indexed + 9/3 non-indexed
    expect(metrics!.meshCount).toBe(1)
    expect(metrics!.textureCount).toBe(3)
    expect(metrics!.textures.map((t) => t.slot)).toEqual(['baseColor', 'normal', 'emissive'])
    expect(metrics!.pbrMapSlots).toEqual({ baseColor: true, normal: true, ao: false, metalnessRoughness: true, emissive: true })
    expect(metrics!.metallicFactorAuthored).toBe(true)
    expect(metrics!.roughnessFactorAuthored).toBe(true)
  })

  it('unauthored factors aggregate to false across materials', () => {
    const metrics = collectIngestionMetrics(glbBuffer({
      materials: [{ pbrMetallicRoughness: { metallicFactor: 1.0 } }, {}],
    }))
    expect(metrics!.metallicFactorAuthored).toBe(false)
    expect(metrics!.roughnessFactorAuthored).toBe(false)
  })

  it('resolves texture dimensions from the GLB binary chunk (PNG)', () => {
    const png = Buffer.alloc(24)
    png.writeUInt32BE(0x89504e47, 0)
    png.writeUInt32BE(64, 16)
    png.writeUInt32BE(32, 20)
    const metrics = collectIngestionMetrics(glbBuffer({
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      textures: [{ image: 0 }],
      images: [{ bufferView: 0, mimeType: 'image/png' }],
      bufferViews: [{ byteOffset: 0, byteLength: png.length }],
    }, png))
    expect(metrics!.textureCount).toBe(1)
    expect(metrics!.textures).toEqual([{ slot: 'baseColor', width: 64, height: 32 }])
  })

  it('returns null for non-GLB buffers', () => {
    expect(collectIngestionMetrics(Buffer.from('not a glb'))).toBeNull()
  })
})

describe('buildAssetIngestionEvent', () => {
  it('produces a valid TelemetryEvent union member with full envelope', () => {
    const metrics = collectIngestionMetrics(glbBuffer({ materials: [{ pbrMetallicRoughness: { metallicFactor: 1 } }] }))!
    const event = buildAssetIngestionEvent('sofa_classic', metrics, { sid: 's1', ver: '1.2.3' })
    expect(event.event).toBe('perf.asset_ingestion')
    expect(event.tier).toBe(1)
    expect(event.app).toBe('buildmy-house')
    expect(event.sid).toBe('s1')
    expect(event.ver).toBe('1.2.3')
    expect(new Date(event.ts).getTime()).not.toBeNaN()
    expect(event.catalogId).toBe('sofa_classic')
    expect(event.metallicFactorAuthored).toBe(true)
    const union: TelemetryEvent = event
    expect(union.event).toBe('perf.asset_ingestion')
  })
})
