import { describe, expect, it } from 'vitest'
import { classifyGlbMaterials } from '../src/services/asset-ingestion-service'

/** Minimal valid GLB: 12-byte header + one JSON chunk, no binary chunk. */
function buildGlb(json: unknown): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8')
  const padding = (4 - (jsonBytes.length % 4)) % 4
  const padded = Buffer.concat([jsonBytes, Buffer.alloc(padding, 0x20)])
  const header = Buffer.alloc(12)
  header.write('glTF', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + padded.length, 8)
  const chunkHeader = Buffer.alloc(8)
  chunkHeader.writeUInt32LE(padded.length, 0)
  chunkHeader.write('JSON', 4, 'ascii')
  return Buffer.concat([header, chunkHeader, padded])
}

describe('classifyGlbMaterials', () => {
  it('tags metallicFactor >= 0.5 as metallic', () => {
    const glb = buildGlb({ materials: [{ pbrMetallicRoughness: { metallicFactor: 1, roughnessFactor: 0.4 } }] })
    expect(classifyGlbMaterials(glb)).toEqual([
      {
        tags: ['metallic'],
        hasBaseColorTexture: false,
        hasMetallicRoughnessTexture: false,
        metallicFactorAuthored: true,
        roughnessFactorAuthored: true,
      },
    ])
  })

  it('tags high roughness as matte, low roughness as glossy, mid as neither', () => {
    const glb = buildGlb({
      materials: [
        { pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.9 } },
        { pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.1 } },
        { pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.5 } },
      ],
    })
    const result = classifyGlbMaterials(glb)
    expect(result?.[0]?.tags).toEqual(['matte'])
    expect(result?.[1]?.tags).toEqual(['glossy'])
    expect(result?.[2]?.tags).toEqual([])
  })

  it('flags missing factors as unauthored instead of tagging spec defaults', () => {
    // Per glTF 2.0 spec, metallicFactor/roughnessFactor default to 1.0 when
    // absent — but the spec default is not an authored value. Such materials
    // get no PBR tags and are flagged via the *Authored booleans so an
    // unauthored material is detectable instead of mislabeled metallic+matte.
    const glb = buildGlb({ materials: [{ name: 'unlit' }] })
    expect(classifyGlbMaterials(glb)).toEqual([
      {
        tags: [],
        hasBaseColorTexture: false,
        hasMetallicRoughnessTexture: false,
        metallicFactorAuthored: false,
        roughnessFactorAuthored: false,
      },
    ])
  })

  it('distinguishes explicit metallicFactor 1.0 from an absent factor', () => {
    const glb = buildGlb({
      materials: [
        { pbrMetallicRoughness: { metallicFactor: 1.0 } },
        { pbrMetallicRoughness: {} },
      ],
    })
    const result = classifyGlbMaterials(glb)!
    // authored 1.0 is a real full-metal signal
    expect(result[0]).toMatchObject({ tags: ['metallic'], metallicFactorAuthored: true, roughnessFactorAuthored: false })
    // absent factor is the spec default, not an authored value
    expect(result[1]).toMatchObject({ tags: [], metallicFactorAuthored: false, roughnessFactorAuthored: false })
  })

  it('treats non-numeric factor values as unauthored', () => {
    const glb = buildGlb({ materials: [{ pbrMetallicRoughness: { metallicFactor: null, roughnessFactor: 'oops' } }] })
    const result = classifyGlbMaterials(glb)![0]!
    expect(result.tags).toEqual([])
    expect(result.metallicFactorAuthored).toBe(false)
    expect(result.roughnessFactorAuthored).toBe(false)
  })

  it('records texture presence per material', () => {
    const glb = buildGlb({
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorTexture: { index: 0 },
            metallicRoughnessTexture: { index: 1 },
          },
        },
        { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
      ],
    })
    expect(classifyGlbMaterials(glb)).toEqual([
      {
        tags: [],
        hasBaseColorTexture: true,
        hasMetallicRoughnessTexture: true,
        metallicFactorAuthored: false,
        roughnessFactorAuthored: false,
      },
      {
        tags: [],
        hasBaseColorTexture: true,
        hasMetallicRoughnessTexture: false,
        metallicFactorAuthored: false,
        roughnessFactorAuthored: false,
      },
    ])
  })

  it('returns null for a non-GLB buffer and [] for a GLB with no materials', () => {
    expect(classifyGlbMaterials(Buffer.from('not a glb'))).toBeNull()
    expect(classifyGlbMaterials(buildGlb({ asset: { version: '2.0' } }))).toEqual([])
  })
})
