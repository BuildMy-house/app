import { describe, it, expect, beforeEach } from 'vitest'
import * as THREE from 'three'
import {
  createEmptyHome,
  effectiveFurnitureTextureId,
  WALL_TEXTURES,
  type Furniture,
} from '../core/home'
import {
  buildScene,
  furnitureMesh,
  floorCoveringLiftCm,
  __seedTextureCache,
  __clearTextureCache,
} from './scene'

function seed(file: string, colorSpace: THREE.ColorSpace = THREE.NoColorSpace): THREE.Texture {
  const tex = new THREE.Texture()
  tex.colorSpace = colorSpace
  __seedTextureCache(file, tex)
  return tex
}

function seedAll(id: string): THREE.Texture {
  const diffuse = seed(`${id}.png`, THREE.SRGBColorSpace)
  seed(`${id}_normal.png`)
  seed(`${id}_roughness.png`)
  seed(`${id}_ao.png`)
  return diffuse
}

function findMesh(scene: THREE.Scene, name: string): THREE.Mesh {
  let found: THREE.Mesh | undefined
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh && o.name === name) found = o
  })
  return found!
}

const sideMat = (mesh: THREE.Mesh): THREE.MeshStandardMaterial =>
  (mesh.material as THREE.MeshStandardMaterial[])[1]!

function maxUv(mesh: THREE.Mesh): number {
  const uv = mesh.geometry.getAttribute('uv')
  let max = 0
  for (let i = 0; i < uv.count; i++) max = Math.max(max, Math.abs(uv.getX(i)), Math.abs(uv.getY(i)))
  return max
}

describe('QA materials: default wall appearance', () => {
  beforeEach(() => __clearTextureCache())

  it('a wall with no chosen texture gets matte plaster scalars but none of the grainy plaster maps', () => {
    seedAll('plaster-white')
    const home = createEmptyHome()
    home.walls.push({ id: 'w1', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 15 })
    const mat = sideMat(findMesh(buildScene(home), 'wall:w1'))
    expect(mat.map).toBeNull()
    expect(mat.normalMap).toBeNull()
    expect(mat.aoMap).toBeNull()
    expect(mat.roughnessMap).toBeNull()
    expect(mat.roughness).toBe(0.9)
  })

  it('a wall with patternId hatchUp (plan hatching) does not leak into 3D materials', () => {
    seedAll('plaster-white')
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 15, patternId: 'hatchUp',
    })
    const mat = sideMat(findMesh(buildScene(home), 'wall:w1'))
    expect(mat.map).toBeNull()
  })

  it('an explicitly chosen plaster-white (side or preference) still gets the full map set', () => {
    seedAll('plaster-white')
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 15,
      leftSideTextureId: 'plaster-white',
    })
    expect(sideMat(findMesh(buildScene(home), 'wall:w1')).map).toBeInstanceOf(THREE.Texture)

    __clearTextureCache()
    seedAll('plaster-white')
    const home2 = createEmptyHome()
    Object.assign(home2.preferences!, { defaultInteriorWallTextureId: 'plaster-white', defaultExteriorWallTextureId: 'plaster-white' })
    home2.walls.push({ id: 'w1', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 15 })
    expect(sideMat(findMesh(buildScene(home2), 'wall:w1')).map).toBeInstanceOf(THREE.Texture)
  })
})

describe('QA materials: oak floor scale', () => {
  beforeEach(() => __clearTextureCache())

  const square = (texId: string) => {
    const home = createEmptyHome()
    home.rooms.push({
      id: 'r1', name: 'R', points: [[0, 0], [200, 0], [200, 200], [0, 200]], floorTextureId: texId,
    } as never)
    return home
  }

  it('oak declares a finer repeat than the 100 cm default and floors honour it', () => {
    expect(WALL_TEXTURES.find((t) => t.id === 'wood-oak')!.tileCm).toBe(50)
    seedAll('wood-oak')
    seedAll('tile-floor')
    expect(maxUv(findMesh(buildScene(square('wood-oak')), 'room:r1'))).toBeCloseTo(4, 6)
    // Entries without tileCm keep 1 repeat / 100 cm.
    expect(maxUv(findMesh(buildScene(square('tile-floor')), 'room:r1'))).toBeCloseTo(2, 6)
  })

  it('ground tiling never mutates the shared cached texture (would restretch floors/walls using it)', () => {
    const oak = seedAll('wood-oak')
    const home = square('wood-oak')
    home.environment.groundColor = 0x88aa66
    home.environment.groundTextureId = 'wood-oak'
    buildScene(home)
    expect(oak.repeat.x).toBe(1)
    expect(oak.repeat.y).toBe(1)
  })
})

describe('QA materials: carpet', () => {
  const carpet: Furniture = {
    id: 'c1', name: 'Carpet', x: 0, y: 0, angleDeg: 0,
    width: 160, depth: 225, height: 1, elevation: 0,
    catalogId: 'sh3d-full#Puybaret#carpet',
  }

  it('catalog carpets default to the carpet texture in plan/box rendering; explicit choice wins', () => {
    expect(effectiveFurnitureTextureId(carpet)).toBe('carpet')
    expect(effectiveFurnitureTextureId({ ...carpet, textureId: 'wood-oak' })).toBe('wood-oak')
    expect(effectiveFurnitureTextureId({ ...carpet, catalogId: 'x#sofa' })).toBeNull()
  })

  it('thin floor coverings are lifted clear of the floor; furniture/doors/raised items are not', () => {
    expect(floorCoveringLiftCm(carpet)).toBeGreaterThan(0)
    expect(floorCoveringLiftCm({ ...carpet, height: 80 })).toBe(0)
    expect(floorCoveringLiftCm({ ...carpet, elevation: 100 })).toBe(0)
    expect(floorCoveringLiftCm({ ...carpet, doorOrWindow: true } as Furniture)).toBe(0)
    const mesh = furnitureMesh(carpet, 0)
    expect(mesh.position.y).toBeCloseTo(0.5 + floorCoveringLiftCm(carpet), 6)
  })
})
