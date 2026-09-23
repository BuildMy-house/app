import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import { createEmptyHome } from '../core/home'
import { buildScene, __seedTextureCache, __clearTextureCache } from './scene'

/**
 * MAT-T2: PBR map wiring. TextureLoader cannot fetch files in the node test
 * environment, so tests seed the texture cache (same pattern as
 * __seedModelCache) and assert on the resulting material properties.
 */

function makeTex(colorSpace: THREE.ColorSpace = THREE.NoColorSpace): THREE.Texture {
  const tex = new THREE.Texture()
  tex.colorSpace = colorSpace
  return tex
}

function seedWoodOak(): void {
  // Diffuse seeds as sRGB (what loadTextureFile configures); PBR maps stay
  // linear — the test asserts the loader never flips them to sRGB.
  __seedTextureCache('wood-oak.png', makeTex(THREE.SRGBColorSpace))
  __seedTextureCache('wood-oak_normal.png', makeTex())
  __seedTextureCache('wood-oak_roughness.png', makeTex())
  __seedTextureCache('wood-oak_ao.png', makeTex())
}

function findMesh(scene: THREE.Scene, name: string): THREE.Mesh | undefined {
  let found: THREE.Mesh | undefined
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh && o.name === name) found = o
  })
  return found
}

/** Walls use an ExtrudeGeometry materials array: [caps, side cladding]. */
function sideMat(mesh: THREE.Mesh): THREE.MeshStandardMaterial {
  return (mesh.material as THREE.MeshStandardMaterial[])[1]!
}

describe('PBR map wiring (MAT-T2)', () => {
  beforeEach(() => {
    __clearTextureCache()
  })

  it('wall material gets normal/roughness/AO maps + scalar defaults from the catalog', () => {
    seedWoodOak()
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 15,
      leftSideTextureId: 'wood-oak',
    })
    const mesh = findMesh(buildScene(home), 'wall:w1')!
    const mat = sideMat(mesh)
    expect(mat.map).toBeInstanceOf(THREE.Texture)
    expect(mat.normalMap).toBeInstanceOf(THREE.Texture)
    expect(mat.roughnessMap).toBeInstanceOf(THREE.Texture)
    expect(mat.aoMap).toBeInstanceOf(THREE.Texture)
    // Non-color maps must stay linear; only the diffuse map is sRGB.
    expect(mat.map!.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(mat.normalMap!.colorSpace).toBe(THREE.NoColorSpace)
    expect(mat.roughnessMap!.colorSpace).toBe(THREE.NoColorSpace)
    expect(mat.aoMap!.colorSpace).toBe(THREE.NoColorSpace)
    // Catalog scalar defaults override the 0.7/0.0 baseline.
    expect(mat.roughness).toBe(0.65)
    expect(mat.metalness).toBe(0)
  })

  it('aoMap geometries get a uv2 attribute (three.js requirement)', () => {
    seedWoodOak()
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 15,
      leftSideTextureId: 'wood-oak',
    })
    home.furniture.push({
      id: 'f1', name: 'Table', x: 200, y: 0, angleDeg: 0,
      width: 100, depth: 50, height: 75, elevation: 0, textureId: 'wood-oak',
    })
    const scene = buildScene(home)
    const wall = findMesh(scene, 'wall:w1')!
    const furniture = findMesh(scene, 'furniture:f1')!
    // uv2 present and shares the uv attribute (single UV-set workaround)
    const wallUv2 = wall.geometry.getAttribute('uv2')
    expect(wallUv2).toBeDefined()
    expect(wallUv2).toBe(wall.geometry.getAttribute('uv'))
    expect(furniture.geometry.getAttribute('uv2')).toBeDefined()
  })

  it('texture-free walls default to plaster-white PBR scalars; furniture keeps its baseline', () => {
    const home = createEmptyHome()
    home.walls.push({ id: 'w1', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 15 })
    home.furniture.push({
      id: 'f1', name: 'Box', x: 200, y: 0, angleDeg: 0,
      width: 100, depth: 50, height: 75, elevation: 0,
    })
    const scene = buildScene(home)
    // Walls now default to the plaster-white catalog entry (matte 0.9
    // roughness); its maps load async, so in node they stay null. Furniture
    // keeps the fabric material's 0.85 baseline (Ticket 5b).
    const expectedRoughness: Record<string, number> = { 'wall:w1': 0.9, 'furniture:f1': 0.85 }
    for (const name of Object.keys(expectedRoughness)) {
      const mesh = findMesh(scene, name)!
      const mat = Array.isArray(mesh.material)
        ? sideMat(mesh)
        : (mesh.material as THREE.MeshStandardMaterial)
      expect(mat.map).toBeNull()
      expect(mat.normalMap).toBeNull()
      expect(mat.roughnessMap).toBeNull()
      expect(mat.aoMap).toBeNull()
      expect(mat.roughness).toBe(expectedRoughness[name])
      expect(mat.metalness).toBe(0)
    }
  })

  it('instanced furniture path applies the same PBR wiring', () => {
    seedWoodOak()
    const home = createEmptyHome()
    for (let i = 0; i < 3; i++) {
      home.furniture.push({
        id: `f${i}`, name: `Chair ${i}`, x: 100 * i, y: 300, angleDeg: 0,
        width: 50, depth: 50, height: 90, elevation: 0, textureId: 'wood-oak',
      })
    }
    const scene = buildScene(home)
    const instanced = scene.getObjectByName('furniture-instanced-unknown') as THREE.Mesh | undefined
    expect(instanced).toBeDefined()
    const mat = instanced!.material as THREE.MeshStandardMaterial
    expect(mat.map).toBeInstanceOf(THREE.Texture)
    expect(mat.normalMap).toBeInstanceOf(THREE.Texture)
    expect(mat.roughness).toBe(0.65)
    expect(instanced!.geometry.getAttribute('uv2')).toBeDefined()
  })

  it('ground material applies PBR maps + scalars for its texture id', () => {
    seedWoodOak()
    const home = createEmptyHome()
    home.environment.groundTextureId = 'wood-oak'
    const ground = findMesh(buildScene(home), 'ground')!
    const mat = ground.material as THREE.MeshStandardMaterial
    expect(mat.map).toBeInstanceOf(THREE.Texture)
    expect(mat.normalMap).toBeInstanceOf(THREE.Texture)
    expect(mat.roughness).toBe(0.65)
    expect(ground.geometry.getAttribute('uv2')).toBeDefined()
  })

  it('tile-floor gets PBR maps + scalar overrides now that maps are shipped', () => {
    __seedTextureCache('tile-floor.png', makeTex(THREE.SRGBColorSpace))
    __seedTextureCache('tile-floor_normal.png', makeTex())
    __seedTextureCache('tile-floor_roughness.png', makeTex())
    __seedTextureCache('tile-floor_ao.png', makeTex())
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 15,
      leftSideTextureId: 'tile-floor',
    })
    const mat = sideMat(findMesh(buildScene(home), 'wall:w1')!)
    expect(mat.map).toBeInstanceOf(THREE.Texture)
    expect(mat.normalMap).toBeInstanceOf(THREE.Texture)
    expect(mat.roughnessMap).toBeInstanceOf(THREE.Texture)
    expect(mat.aoMap).toBeInstanceOf(THREE.Texture)
    expect(mat.roughness).toBe(0.35)
    expect(mat.metalness).toBe(0)
  })

  it('room floor material gets PBR maps + uv2 when floorTextureId resolves', () => {
    seedWoodOak()
    const home = createEmptyHome()
    home.rooms.push({
      id: 'r1', points: [[0, 0], [100, 0], [100, 100]], floorTextureId: 'wood-oak',
    })
    const mesh = findMesh(buildScene(home), 'room:r1')!
    const mat = mesh.material as THREE.MeshStandardMaterial
    expect(mat.map).toBeInstanceOf(THREE.Texture)
    expect(mat.normalMap).toBeInstanceOf(THREE.Texture)
    expect(mat.roughnessMap).toBeInstanceOf(THREE.Texture)
    expect(mat.aoMap).toBeInstanceOf(THREE.Texture)
    expect(mat.map!.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(mat.roughness).toBe(0.65)
    const uv2 = mesh.geometry.getAttribute('uv2')
    expect(uv2).toBeDefined()
    expect(uv2).toBe(mesh.geometry.getAttribute('uv'))
  })

  it('texture-free room floor keeps baseline material and gets no PBR maps', () => {
    const home = createEmptyHome()
    home.rooms.push({
      id: 'r1', points: [[0, 0], [100, 0], [100, 100]], floorTextureId: null,
    })
    const mat = findMesh(buildScene(home), 'room:r1')!.material as THREE.MeshStandardMaterial
    expect(mat.map).toBeNull()
    expect(mat.normalMap).toBeNull()
    expect(mat.roughnessMap).toBeNull()
    expect(mat.aoMap).toBeNull()
    expect(mat.roughness).toBe(0.7)
  })

  it('a texture whose URL fails to load never assigns an empty Texture to the material', () => {
    // No cache seeding: TextureLoader cannot fetch in node, so every map for
    // this texture id fails — regression for the "Texture marked for update
    // but no image data found" warnings (empty maps were assigned and then
    // sampled as black AO/normal + roughness 0, rendering walls black).
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 15,
      leftSideTextureId: 'plaster-white',
    })
    const mat = sideMat(findMesh(buildScene(home), 'wall:w1')!)
    expect(mat.map).toBeNull()
    expect(mat.normalMap).toBeNull()
    expect(mat.roughnessMap).toBeNull()
    expect(mat.aoMap).toBeNull()
    // Catalog scalar defaults still apply as the graceful fallback.
    expect(mat.roughness).toBe(0.9)
    expect(mat.metalness).toBe(0)
  })
})
