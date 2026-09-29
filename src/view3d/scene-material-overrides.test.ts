import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import { createEmptyHome } from '../core/home'
import {
  buildScene,
  __seedModelCache,
  __seedTextureCache,
  __clearTextureCache,
  getFurnitureMaterialSlots,
} from './scene'

/**
 * Ticket 4: multi-material per-slot override support. Materials are named
 * exactly as glTF material names survive real OBJ->glTF asset-ingestion
 * export (confirmed via the real catalog under .sh3d-scratch/output/models).
 */
function fakeMultiMaterialDoorModel(): THREE.Group {
  const group = new THREE.Group()
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ name: 'Frame', color: 0x8b5a3c }),
  )
  group.add(frame)
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ name: 'Panel', color: 0xdddddd }),
  )
  group.add(panel)
  const handle = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.1, 0.1),
    new THREE.MeshStandardMaterial({ name: 'Handle', color: 0x999999, metalness: 0.8 }),
  )
  group.add(handle)
  return group
}

function makeTex(colorSpace: THREE.ColorSpace = THREE.NoColorSpace): THREE.Texture {
  const tex = new THREE.Texture()
  tex.colorSpace = colorSpace
  return tex
}

function seedWoodOak(): void {
  __seedTextureCache('wood-oak.png', makeTex(THREE.SRGBColorSpace))
  __seedTextureCache('wood-oak_normal.png', makeTex())
  __seedTextureCache('wood-oak_roughness.png', makeTex())
  __seedTextureCache('wood-oak_ao.png', makeTex())
}

function slotMaterials(scene: THREE.Scene, itemId: string): Map<string, THREE.MeshStandardMaterial> {
  const out = new Map<string, THREE.MeshStandardMaterial>()
  const mesh = scene.getObjectByName(`furniture:${itemId}`)
  mesh?.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh && !Array.isArray(m.material)) {
      out.set((m.material as THREE.MeshStandardMaterial).name, m.material as THREE.MeshStandardMaterial)
    }
  })
  return out
}

describe('furniture per-slot material overrides (Ticket 4)', () => {
  const MODEL_URL = 'assets/door.glb'

  beforeEach(() => {
    __clearTextureCache()
  })

  function makeHome(materialOverrides?: Record<string, string | null>) {
    const home = createEmptyHome()
    home.furniture.push({
      id: 'd1', name: 'Door', modelPath: 'door.glb',
      x: 0, y: 0, angleDeg: 0, width: 100, depth: 10, height: 200, elevation: 0,
      materialOverrides,
    })
    return home
  }

  it('getFurnitureMaterialSlots lists every named material on the loaded model', () => {
    __seedModelCache(MODEL_URL, fakeMultiMaterialDoorModel())
    const scene = buildScene(makeHome(), { modelUrlResolver: (p) => `assets/${p}` })
    expect(getFurnitureMaterialSlots(scene, 'd1').sort()).toEqual(['Frame', 'Handle', 'Panel'])
  })

  it('returns an empty list for furniture with no loaded model (box fallback)', () => {
    const home = createEmptyHome()
    home.furniture.push({
      id: 'box1', name: 'Box', x: 0, y: 0, angleDeg: 0,
      width: 50, depth: 50, height: 50, elevation: 0,
    })
    const scene = buildScene(home)
    expect(getFurnitureMaterialSlots(scene, 'box1')).toEqual([])
  })

  it('applies an override texture to only the targeted slot, leaving others untouched', () => {
    seedWoodOak()
    __seedModelCache(MODEL_URL, fakeMultiMaterialDoorModel())
    const scene = buildScene(makeHome({ Panel: 'wood-oak' }), {
      modelUrlResolver: (p) => `assets/${p}`,
    })
    const mats = slotMaterials(scene, 'd1')
    expect(mats.get('Panel')!.map).toBeInstanceOf(THREE.Texture)
    expect(mats.get('Frame')!.map).toBeNull()
    expect(mats.get('Handle')!.map).toBeNull()
  })

  it('a null override value clears the map instead of leaving a stale texture', () => {
    seedWoodOak()
    __seedModelCache(MODEL_URL, fakeMultiMaterialDoorModel())
    const scene = buildScene(makeHome({ Panel: null }), {
      modelUrlResolver: (p) => `assets/${p}`,
    })
    expect(slotMaterials(scene, 'd1').get('Panel')!.map).toBeNull()
  })

  it('furniture without materialOverrides renders every slot with its original material untouched', () => {
    __seedModelCache(MODEL_URL, fakeMultiMaterialDoorModel())
    const scene = buildScene(makeHome(undefined), { modelUrlResolver: (p) => `assets/${p}` })
    const mats = slotMaterials(scene, 'd1')
    expect(mats.get('Frame')!.color.getHex()).toBe(0x8b5a3c)
    expect(mats.get('Panel')!.color.getHex()).toBe(0xdddddd)
    expect(mats.get('Handle')!.color.getHex()).toBe(0x999999)
  })
})
