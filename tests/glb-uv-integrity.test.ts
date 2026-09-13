import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MODELS_DIR = join(__dirname, '..', 'assets', 'models')

interface GltfMaterial {
  pbrMetallicRoughness?: {
    baseColorTexture?: unknown
  }
}

interface GltfPrimitive {
  attributes: Record<string, number>
  material?: number
}

interface GltfMesh {
  primitives: GltfPrimitive[]
}

interface GltfRoot {
  meshes?: GltfMesh[]
  materials?: GltfMaterial[]
}

function parseGlbJson(glbBuffer: Buffer): GltfRoot {
  const magic = glbBuffer.readUInt32LE(0)
  expect(magic).toBe(0x46546c67) // glTF magic

  const jsonChunkLength = glbBuffer.readUInt32LE(12)
  const jsonChunkType = glbBuffer.readUInt32LE(16)
  expect(jsonChunkType).toBe(0x4e4f534a) // JSON chunk type

  const jsonStr = glbBuffer.toString('utf8', 20, 20 + jsonChunkLength)
  return JSON.parse(jsonStr) as GltfRoot
}

describe('GLB UV integrity', () => {
  const glbFiles = readdirSync(MODELS_DIR).filter((f) => f.endsWith('.glb'))

  it('has GLB files to validate', () => {
    expect(glbFiles.length).toBeGreaterThan(0)
  })

  for (const file of glbFiles) {
    it(`${file} does not reference baseColorTexture without TEXCOORD_0`, () => {
      const glb = readFileSync(join(MODELS_DIR, file))
      const root = parseGlbJson(glb)

      if (!root.meshes || !root.materials) return

      for (const mesh of root.meshes) {
        for (const prim of mesh.primitives) {
          if (prim.material === undefined) continue
          const mat = root.materials[prim.material]
          if (!mat?.pbrMetallicRoughness?.baseColorTexture) continue

          expect(prim.attributes, `${file}: mesh with texture must have TEXCOORD_0`).toHaveProperty('TEXCOORD_0')
        }
      }
    })
  }
})
