import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createEmptyHome, getDefaultCeilingVisibility, DEFAULT_WALL_HEIGHT_CM, type Furniture } from '../core/home'
import { HomeStore } from '../core/store'
import { HomeModel } from '../core/model'
import { PlanEngine } from '../plan/engine'
import { wallOutlinePoints } from '../core/top-camera-follower'
import {
  BELOW_CEILING_Z_FIGHT_OFFSET_CM,
  buildScene,
  remapExtrudeUvs,
  __seedModelCache,
  __seedTextureCache,
  __clearTextureCache,
  SELECTION_EMISSIVE_COLOR,
  isWindowFurniture,
  shouldShowCeiling,
} from './scene'
import {
  applySceneUpdate,
  computeSceneUpdates,
  isTransformOnlyFurnitureChange,
} from './scene-delta'

/**
 * Extract every unique XZ position from a THREE.BufferGeometry's position
 * attribute, transformed to world space using the mesh's position.
 * Y is ignored (height axis).
 */
function worldXZPositions(mesh: THREE.Mesh): Array<[number, number]> {
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute
  const px = mesh.position.x
  const pz = mesh.position.z
  const seen = new Set<string>()
  const result: Array<[number, number]> = []
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + px
    const z = pos.getZ(i) + pz
    const key = `${x.toFixed(6)},${z.toFixed(6)}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push([x, z])
    }
  }
  return result
}

function wallMeshes(scene: THREE.Scene): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = []
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.name.startsWith('wall:')) meshes.push(obj)
  })
  return meshes
}

function ceilingMeshes(scene: THREE.Scene): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = []
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.name.startsWith('ceiling:')) meshes.push(obj)
  })
  return meshes
}

function roofMeshes(scene: THREE.Scene): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = []
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.name.startsWith('roof:')) meshes.push(obj)
  })
  return meshes
}

describe('roof 3D extrusion (X3)', () => {
  it('builds a sloped roof mesh with overhang at the level height', () => {
    const home = createEmptyHome()
    home.levels.push({
      id: 'level-1', name: 'Ground', elevation: 10, floorThickness: 5,
      height: 250, visible: true, viewable: true,
    })
    home.roofs.push({
      id: 'roof-1', points: [[0, 0], [400, 0], [400, 200], [0, 200]],
      levelRef: 'level-1', style: 'gable', pitchDeg: 30, overhangCm: 20,
    })

    const mesh = roofMeshes(buildScene(home, { isOutsideView: true }))[0]!
    const positions = mesh.geometry.getAttribute('position')
    const ys = Array.from({ length: positions.count }, (_, i) => positions.getY(i))

    expect(Math.min(...ys)).toBe(260)
    expect(Math.max(...ys)).toBeGreaterThan(260)
    expect(mesh.geometry.boundingBox).toBeNull()
    mesh.geometry.computeBoundingBox()
    expect(mesh.geometry.boundingBox!.min.x).toBe(-20)
    expect(mesh.geometry.boundingBox!.max.x).toBe(420)
  })
})

// ── Ticket 4: roof cutaway / hide-roof mode ─────────────────────────────────

describe('showRoof option (roof cutaway / hide-roof mode)', () => {
  function homeWithRoof(): ReturnType<typeof createEmptyHome> {
    const home = createEmptyHome()
    home.levels.push({
      id: 'level-1', name: 'Ground', elevation: 0, floorThickness: 5,
      height: 250, visible: true, viewable: true,
    })
    home.roofs.push({
      id: 'roof-1', points: [[0, 0], [400, 0], [400, 200], [0, 200]],
      levelRef: 'level-1', style: 'gable', pitchDeg: 30, overhangCm: 20,
    })
    return home
  }

  it('shows the roof by default (option omitted) in outside view', () => {
    const scene = buildScene(homeWithRoof(), { isOutsideView: true })
    expect(roofMeshes(scene).length).toBe(1)
  })

  it('shows the roof when showRoof is explicitly true (outside view)', () => {
    const scene = buildScene(homeWithRoof(), { showRoof: true, isOutsideView: true })
    expect(roofMeshes(scene).length).toBe(1)
  })

  it('hides every roof mesh when showRoof is false', () => {
    const scene = buildScene(homeWithRoof(), { showRoof: false })
    expect(roofMeshes(scene).length).toBe(0)
  })

  it('showRoof=false hides roofs even in outside view (all-levels) mode', () => {
    const scene = buildScene(homeWithRoof(), { showRoof: false, isOutsideView: true })
    expect(roofMeshes(scene).length).toBe(0)
  })

  it('showRoof=false does not affect walls/rooms — only roofs are hidden', () => {
    const home = homeWithRoof()
    home.rooms.push({
      id: 'r1', points: [[0, 0], [100, 0], [100, 100], [0, 100]],
      levelRef: 'level-1',
    })
    const scene = buildScene(home, { showRoof: false })
    expect(roofMeshes(scene).length).toBe(0)
    expect(ceilingMeshes(scene).length).toBe(0) // interior view: ceilings stay hidden too
    const rooms = scene.getObjectByName('home')
    expect(rooms).toBeDefined()
  })
})

// ── Interior-view roof hiding (single-story) ────────────────────────────────

describe('interior-view roof hiding', () => {
  function homeWithRoof(levelOverrides?: { id: string; elevation: number; height: number }[]): ReturnType<typeof createEmptyHome> {
    const home = createEmptyHome()
    const levels = levelOverrides ?? [{ id: 'level-1', elevation: 0, height: 250 }]
    for (const l of levels) {
      home.levels.push({ id: l.id, name: l.id, elevation: l.elevation, floorThickness: 5, height: l.height, visible: true, viewable: true })
    }
    home.roofs.push({
      id: 'roof-1', points: [[0, 0], [400, 0], [400, 200], [0, 200]],
      levelRef: levels[0]!.id, style: 'gable', pitchDeg: 30, overhangCm: 20,
    })
    return home
  }

  it('hides roof in interior view when single-story (no level above)', () => {
    const scene = buildScene(homeWithRoof(), { activeLevel: 'level-1', isOutsideView: false })
    expect(roofMeshes(scene).length).toBe(0)
  })

  it('shows roof in outside view even when single-story', () => {
    const scene = buildScene(homeWithRoof(), { activeLevel: 'level-1', isOutsideView: true })
    expect(roofMeshes(scene).length).toBe(1)
  })

  it('shows roof in interior view when level above exists (multi-story)', () => {
    const home = homeWithRoof([
      { id: 'level-1', elevation: 0, height: 250 },
      { id: 'level-2', elevation: 250, height: 250 },
    ])
    const scene = buildScene(home, { activeLevel: 'level-1', isOutsideView: false })
    expect(roofMeshes(scene).length).toBe(1)
  })

  it('hides roof in interior view on top level with no level above', () => {
    const home = homeWithRoof([
      { id: 'level-1', elevation: 0, height: 250 },
      { id: 'level-2', elevation: 250, height: 250 },
    ])
    home.roofs[0]!.levelRef = 'level-2'
    const scene = buildScene(home, { activeLevel: 'level-2', isOutsideView: false })
    expect(roofMeshes(scene).length).toBe(0)
  })

  it('shows roof in interior view on lower level when level above exists', () => {
    const home = homeWithRoof([
      { id: 'level-1', elevation: 0, height: 250 },
      { id: 'level-2', elevation: 250, height: 250 },
    ])
    home.roofs[0]!.levelRef = 'level-1'
    const scene = buildScene(home, { activeLevel: 'level-1', isOutsideView: false })
    expect(roofMeshes(scene).length).toBe(1)
  })

  // Regression: activeLevel stays null ("All levels") by default for every
  // new/single-story home — this is the common state a user lands in, not an
  // edge case. The topmost roof (no level above it) must hide here exactly
  // as it does when that level is explicitly selected, otherwise the roof
  // renders "always present" for anyone who never touches the floor
  // selector.
  it('hides roof when activeLevel is null (all-levels view, single-story)', () => {
    const scene = buildScene(homeWithRoof(), { activeLevel: null, isOutsideView: false })
    expect(roofMeshes(scene).length).toBe(0)
  })

  it('shows roof in outside view when activeLevel is null', () => {
    const scene = buildScene(homeWithRoof(), { activeLevel: null, isOutsideView: true })
    expect(roofMeshes(scene).length).toBe(1)
  })

  it('hides the topmost roof when activeLevel is null (all-levels, multi-story)', () => {
    const home = homeWithRoof([
      { id: 'level-1', elevation: 0, height: 250 },
      { id: 'level-2', elevation: 250, height: 250 },
    ])
    home.roofs[0]!.levelRef = 'level-2'
    const scene = buildScene(home, { activeLevel: null, isOutsideView: false })
    expect(roofMeshes(scene).length).toBe(0)
  })

  it('shows an interstitial roof underside when activeLevel is null (all-levels, multi-story)', () => {
    const home = homeWithRoof([
      { id: 'level-1', elevation: 0, height: 250 },
      { id: 'level-2', elevation: 250, height: 250 },
    ])
    home.roofs[0]!.levelRef = 'level-1'
    const scene = buildScene(home, { activeLevel: null, isOutsideView: false })
    expect(roofMeshes(scene).length).toBe(1)
  })
})

// ── M53b: arc walls extrude as a curved 3D shape ────────────────────────────

describe('arc wall 3D extrusion (M53b)', () => {
  const ARC = { id: 'arc', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 15, arcExtent: Math.PI / 2 }

  function sortedXZ(positions: Array<[number, number]>): Array<[number, number]> {
    return [...positions].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  }

  it('a straight wall still extrudes as the exact flat box (byte-identical)', () => {
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0,
      thickness: 15, leftSideColor: 0xd2d2d2,
    })
    const scene = buildScene(home)
    const mesh = wallMeshes(scene)[0]!
    const half = 7.5
    expect(sortedXZ(worldXZPositions(mesh))).toEqual(sortedXZ([
      [0, -half], [0, half], [100, -half], [100, half],
    ]))
  })

  it("an arc wall's XZ vertices trace the same curved outline as wallOutlinePoints", () => {
    const home = createEmptyHome()
    home.walls.push(ARC)
    const scene = buildScene(home)
    const mesh = wallMeshes(scene)[0]!

    const outline = wallOutlinePoints(ARC, [ARC])
    const world = worldXZPositions(mesh)

    // Every outline point must appear as a geometry vertex in the XZ plane.
    for (const [ox, oy] of outline) {
      const hit = world.some(([x, z]) => Math.abs(x - ox) < 1e-3 && Math.abs(z - oy) < 1e-3)
      expect(hit).toBe(true)
    }

    // The curved outline bulges well past the ±thickness/2 flat-box bound.
    const minZ = Math.min(...world.map(([, z]) => z))
    expect(minZ).toBeLessThan(-7.5)
    expect(outline.length).toBeGreaterThan(4)
  })

  it('an arc wall ignores door/window openings (full uncut extrusion, single mesh)', () => {
    const home = createEmptyHome()
    home.walls.push(ARC)
    home.furniture.push({
      id: 'd1', name: 'Door',
      x: 50, y: 0, angleDeg: 0,
      width: 90, depth: 15, height: 210,
      elevation: 0,
      doorOrWindow: true, wallRef: 'arc', wallOffset: 50,
    })
    const scene = buildScene(home)
    expect(wallMeshes(scene).length).toBe(1)
  })
})

// ── M50: wall corners join correctly at shared endpoints ─────────────

describe('wall corner mitering (M50)', () => {
  it('L-shape corner vertices reach the true miter intersection', () => {
    const home = createEmptyHome()
    const thickness = 15
    // Wall A: horizontal, (0,0) → (100,0)
    home.walls.push({
      id: 'wA', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0,
      thickness, leftSideColor: 0xd2d2d2,
    })
    // Wall B: vertical, (100,0) → (100,100)
    home.walls.push({
      id: 'wB', xStart: 100, yStart: 0, xEnd: 100, yEnd: 100,
      thickness, leftSideColor: 0xd2d2d2,
    })

    const scene = buildScene(home)
    const meshes = wallMeshes(scene)
    expect(meshes.length).toBe(2)

    const half = thickness / 2
    // Miter intersection for an L-corner at (100,0) with equal thickness:
    //   inner corner = (100 - half, 0 + half) = (92.5, 7.5)
    //   outer corner = (100 + half, 0 - half) = (107.5, -7.5)
    // In Three.js X-Z plane (scene uses Y-up, XZ for floor):
    const innerCorner: [number, number] = [100 - half, half]
    const outerCorner: [number, number] = [100 + half, -half]

    for (const mesh of meshes) {
      const positions = worldXZPositions(mesh)

      const hasInner = positions.some(
        ([x, z]) => Math.abs(x - innerCorner[0]) < 0.5 && Math.abs(z - innerCorner[1]) < 0.5,
      )
      const hasOuter = positions.some(
        ([x, z]) => Math.abs(x - outerCorner[0]) < 0.5 && Math.abs(z - outerCorner[1]) < 0.5,
      )

      expect(hasInner).toBe(true)
      expect(hasOuter).toBe(true)
    }
  })

  it('no openings wall produces a single mesh (not a group)', () => {
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 200, yEnd: 0,
      thickness: 15, leftSideColor: 0xd2d2d2,
    })

    const scene = buildScene(home)
    const meshes = wallMeshes(scene)
    expect(meshes.length).toBe(1)
    expect(meshes[0]!.geometry.getAttribute('position').count).toBeGreaterThan(0)
  })

  it('wall with openings produces multiple meshes in a group', () => {
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0,
      thickness: 15, leftSideColor: 0xd2d2d2,
    })
    home.furniture.push({
      id: 'd1', name: 'Door',
      x: 200, y: 0, angleDeg: 0,
      width: 90, depth: 15, height: 210,
      elevation: 0,
      doorOrWindow: true, wallRef: 'w1', wallOffset: 200,
    })

    const scene = buildScene(home)
    const meshes = wallMeshes(scene)
    // Multiple segments around the opening
    expect(meshes.length).toBeGreaterThan(1)
  })
})

// ── M52: wall texture UV remapping ────────────────────────────────────────

describe('remapExtrudeUvs', () => {
  it('sets V from Y (height) not Z after rotateX(-π/2)', () => {
    // Mimic the wall geometry: extruded shape, then rotated so height is on Y.
    const shape = new THREE.Shape()
    shape.moveTo(-50, -7.5)
    shape.lineTo(50, -7.5)
    shape.lineTo(50, 7.5)
    shape.lineTo(-50, 7.5)
    shape.closePath()
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 250, bevelEnabled: false })
    geometry.rotateX(-Math.PI / 2)

    remapExtrudeUvs(geometry)

    const pos = geometry.getAttribute('position')
    const uv = geometry.getAttribute('uv')
    expect(pos).toBeDefined()
    expect(uv).toBeDefined()

    // Collect (Y, V) pairs
    const yvPairs: Array<{ y: number; v: number }> = []
    for (let i = 0; i < pos.count; i++) {
      yvPairs.push({ y: pos.getY(i), v: uv.getY(i) })
    }

    // Find vertices at min Y and max Y
    const minY = Math.min(...yvPairs.map((p) => p.y))
    const maxY = Math.max(...yvPairs.map((p) => p.y))
    expect(maxY - minY).toBeGreaterThan(100) // geometry spans meaningful height

    const vAtMinY = yvPairs.filter((p) => Math.abs(p.y - minY) < 0.01).map((p) => p.v)
    const vAtMaxY = yvPairs.filter((p) => Math.abs(p.y - maxY) < 0.01).map((p) => p.v)

    const avgVMinY = vAtMinY.reduce((a, b) => a + b, 0) / vAtMinY.length
    const avgVMaxY = vAtMaxY.reduce((a, b) => a + b, 0) / vAtMaxY.length

    // V must differ significantly between bottom and top of the wall
    const vSpread = Math.abs(avgVMaxY - avgVMinY)
    expect(vSpread).toBeGreaterThan(0.5)

    // V should roughly equal Y / 100
    expect(avgVMinY).toBeCloseTo(minY / 100, 1)
    expect(avgVMaxY).toBeCloseTo(maxY / 100, 1)
  })

  it('U uses X (wall length direction)', () => {
    const shape = new THREE.Shape()
    shape.moveTo(-50, -7.5)
    shape.lineTo(50, -7.5)
    shape.lineTo(50, 7.5)
    shape.lineTo(-50, 7.5)
    shape.closePath()
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 250, bevelEnabled: false })
    geometry.rotateX(-Math.PI / 2)

    remapExtrudeUvs(geometry)

    const pos = geometry.getAttribute('position')
    const uv = geometry.getAttribute('uv')

    // U should roughly equal X / 100
    const uAtX50 = Array.from({ length: pos.count }, (_, i) => ({ x: pos.getX(i), u: uv.getX(i) }))
      .filter((p) => Math.abs(p.x - 50) < 0.01)
      .map((p) => p.u)
    expect(uAtX50.length).toBeGreaterThan(0)
    const avgU = uAtX50.reduce((a, b) => a + b, 0) / uAtX50.length
    expect(avgU).toBeCloseTo(50 / 100, 1)
  })
})

// ── M56: ceiling mesh Y uses level.height, not level.elevation ──────────────

describe('ceiling mesh height (M56)', () => {
  it('ground-floor room (elevation=0, height=250) puts ceiling at Y≈250', () => {
    const home = createEmptyHome()
    home.levels.push({
      id: 'L0', name: 'Ground', elevation: 0,
      floorThickness: 0, height: 250, visible: true, viewable: true,
    })
    home.rooms.push({
      id: 'r1', points: [[0, 0], [100, 0], [100, 100], [0, 100]],
      levelRef: 'L0',
    })
    const scene = buildScene(home, { isOutsideView: true })
    const ceilings = ceilingMeshes(scene)
    expect(ceilings.length).toBe(1)
    expect(ceilings[0]!.position.y).toBeCloseTo(250, 0)
  })

  it('raised level (elevation=100, height=300) puts ceiling at Y≈400', () => {
    const home = createEmptyHome()
    home.levels.push({
      id: 'L1', name: 'Upper', elevation: 100,
      floorThickness: 0, height: 300, visible: true, viewable: true,
    })
    home.rooms.push({
      id: 'r1', points: [[0, 0], [100, 0], [100, 100], [0, 100]],
      levelRef: 'L1',
    })
    const scene = buildScene(home, { isOutsideView: true })
    const ceilings = ceilingMeshes(scene)
    expect(ceilings.length).toBe(1)
    expect(ceilings[0]!.position.y).toBeCloseTo(400, 0)
  })

  it('room with no levelRef uses DEFAULT_WALL_HEIGHT_CM', () => {
    const home = createEmptyHome()
    home.rooms.push({
      id: 'r1', points: [[0, 0], [100, 0], [100, 100], [0, 100]],
    })
    const scene = buildScene(home, { isOutsideView: true })
    const ceilings = ceilingMeshes(scene)
    expect(ceilings.length).toBe(1)
    expect(ceilings[0]!.position.y).toBeCloseTo(DEFAULT_WALL_HEIGHT_CM, 0)
  })

  it('ceilingVisible=false suppresses ceiling mesh', () => {
    const home = createEmptyHome()
    home.levels.push({
      id: 'L0', name: 'Ground', elevation: 0,
      floorThickness: 0, height: 250, visible: true, viewable: true,
    })
    home.rooms.push({
      id: 'r1', points: [[0, 0], [100, 0], [100, 100], [0, 100]],
      levelRef: 'L0', ceilingVisible: false,
    })
    const scene = buildScene(home)
    const ceilings = ceilingMeshes(scene)
    expect(ceilings.length).toBe(0)
  })

  it('ceiling material is not near-white — regression guard against tonemap/bloom blowout', () => {
    // 0xf0f0f0 previously used here clipped to a "glowing white" ceiling under
    // ACES tonemapping + bloom when viewed from outside/top-down, since the
    // ceiling faces almost directly into the downward directional lights.
    // Must stay at or below DEFAULT_FLOOR_COLOR's brightness (0xc8c8c8), which
    // is proven safe under the same light rig.
    const home = createEmptyHome()
    home.levels.push({
      id: 'L0', name: 'Ground', elevation: 0,
      floorThickness: 0, height: 250, visible: true, viewable: true,
    })
    home.rooms.push({
      id: 'r1', points: [[0, 0], [100, 0], [100, 100], [0, 100]],
      levelRef: 'L0',
    })
    const scene = buildScene(home, { isOutsideView: true })
    const ceiling = ceilingMeshes(scene)[0]!
    const material = ceiling.material as THREE.MeshStandardMaterial
    expect(material.color.getHex()).toBeLessThanOrEqual(0xc8c8c8)
  })
})

// ── M60: furniture horizontal flip (mirror) ──────────────────────────────

function furnitureMeshes(scene: THREE.Scene): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = []
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.name.startsWith('furniture:')) meshes.push(obj)
  })
  return meshes
}

describe('furniture mirror (M60)', () => {
  it('non-mirrored furniture has scale.x = 1', () => {
    const home = createEmptyHome()
    home.furniture.push({
      id: 'f1', name: 'Sofa',
      x: 100, y: 200, angleDeg: 0,
      width: 200, depth: 80, height: 90,
      elevation: 0,
    })
    const scene = buildScene(home)
    const meshes = furnitureMeshes(scene)
    expect(meshes.length).toBe(1)
    expect(meshes[0]!.scale.x).toBe(1)
  })

  it('mirrored furniture has scale.x = -1', () => {
    const home = createEmptyHome()
    home.furniture.push({
      id: 'f1', name: 'Sofa',
      x: 100, y: 200, angleDeg: 0,
      width: 200, depth: 80, height: 90,
      elevation: 0,
      modelMirrored: true,
    })
    const scene = buildScene(home)
    const meshes = furnitureMeshes(scene)
    expect(meshes.length).toBe(1)
    expect(meshes[0]!.scale.x).toBe(-1)
  })

  it('mirrored box geometry retains valid index and normals (no culled faces)', () => {
    const home = createEmptyHome()
    home.furniture.push({
      id: 'f1', name: 'Table',
      x: 0, y: 0, angleDeg: 0,
      width: 100, depth: 60, height: 75,
      elevation: 0,
      modelMirrored: true,
    })
    const scene = buildScene(home)
    const meshes = furnitureMeshes(scene)
    const mesh = meshes[0]!

    // Index buffer exists and is non-empty (faces are defined)
    const index = mesh.geometry.getIndex()
    expect(index).not.toBeNull()
    expect(index!.count).toBeGreaterThan(0)

    // Normal attribute exists and contains non-zero vectors
    const normals = mesh.geometry.getAttribute('normal')
    expect(normals).toBeDefined()
    expect(normals.count).toBeGreaterThan(0)
    let hasNonZeroNormal = false
    for (let i = 0; i < normals.count; i++) {
      if (normals.getX(i) !== 0 || normals.getY(i) !== 0 || normals.getZ(i) !== 0) {
        hasNonZeroNormal = true
        break
      }
    }
    expect(hasNonZeroNormal).toBe(true)
  })

  it('mirror composes with rotation correctly', () => {
    const home = createEmptyHome()
    home.furniture.push({
      id: 'f1', name: 'Chair',
      x: 50, y: 50, angleDeg: 90,
      width: 60, depth: 60, height: 80,
      elevation: 0,
      modelMirrored: true,
    })
    const scene = buildScene(home)
    const meshes = furnitureMeshes(scene)
    const mesh = meshes[0]!
    expect(mesh.scale.x).toBe(-1)
    expect(mesh.rotation.y).toBeCloseTo(Math.PI / 2, 10)
  })
})

describe('window glass material (Ticket 5a)', () => {
  function windowItem(id: string, overrides: Partial<Furniture> = {}): Furniture {
    return {
      id, name: 'Window',
      x: 0, y: 0, angleDeg: 0,
      width: 120, depth: 10, height: 100,
      elevation: 90,
      doorOrWindow: true,
      ...overrides,
    }
  }

  it('isWindowFurniture requires both doorOrWindow and a name match', () => {
    expect(isWindowFurniture(windowItem('w1'))).toBe(true)
    expect(isWindowFurniture(windowItem('w2', { name: 'Sliding Window' }))).toBe(true)
    expect(isWindowFurniture(windowItem('w3', { doorOrWindow: false }))).toBe(false)
    expect(isWindowFurniture(windowItem('w4', { name: 'Door' }))).toBe(false)
    expect(
      isWindowFurniture({
        id: 'w5', name: 'Sofa', x: 0, y: 0, angleDeg: 0,
        width: 100, depth: 50, height: 80, elevation: 0,
      }),
    ).toBe(false)
  })

  it('window furniture gets a transmissive MeshPhysicalMaterial, not the flat box material', () => {
    const home = createEmptyHome()
    home.furniture.push(windowItem('w1'))
    const scene = buildScene(home)
    const mesh = furnitureMeshes(scene)[0]!
    expect(mesh.material).toBeInstanceOf(THREE.MeshPhysicalMaterial)
    const mat = mesh.material as THREE.MeshPhysicalMaterial
    expect(mat.transmission).toBeGreaterThan(0)
  })

  it('non-window furniture gets the fabric material (Ticket 5b), not transmissive glass', () => {
    const home = createEmptyHome()
    home.furniture.push({
      id: 'f1', name: 'Sofa',
      x: 0, y: 0, angleDeg: 0,
      width: 200, depth: 80, height: 90,
      elevation: 0,
    })
    const scene = buildScene(home)
    const mesh = furnitureMeshes(scene)[0]!
    expect(mesh.material).toBeInstanceOf(THREE.MeshPhysicalMaterial)
    expect((mesh.material as THREE.MeshPhysicalMaterial).transmission).toBe(0)
  })

  it('a door (doorOrWindow=true but name Door) is not treated as glass (no transmission)', () => {
    const home = createEmptyHome()
    home.furniture.push(windowItem('d1', { name: 'Door', doorOrWindow: true }))
    const scene = buildScene(home)
    const mesh = furnitureMeshes(scene)[0]!
    expect((mesh.material as THREE.MeshPhysicalMaterial).transmission).toBe(0)
  })

  it('multiple identical windows are excluded from instancing and each render individually', () => {
    const home = createEmptyHome()
    for (let i = 0; i < 3; i++) home.furniture.push(windowItem(`w${i}`, { x: i * 150 }))
    const scene = buildScene(home)
    expect(instancedFurnitureMeshes(scene).length).toBe(0)
    const meshes = furnitureMeshes(scene)
    expect(meshes.length).toBe(3)
    for (const mesh of meshes) {
      expect(mesh.material).toBeInstanceOf(THREE.MeshPhysicalMaterial)
    }
  })
})

describe('furniture fabric material (Ticket 5b)', () => {
  it('box furniture without a GLB model gets a sheen fabric material', () => {
    const home = createEmptyHome()
    home.furniture.push({
      id: 'f1', name: 'Armchair',
      x: 0, y: 0, angleDeg: 0,
      width: 90, depth: 90, height: 80,
      elevation: 0, color: 0x336699,
    })
    const scene = buildScene(home)
    const mesh = furnitureMeshes(scene)[0]!
    const mat = mesh.material as THREE.MeshPhysicalMaterial
    expect(mat).toBeInstanceOf(THREE.MeshPhysicalMaterial)
    expect(mat.sheen).toBeGreaterThan(0)
    expect(mat.color.getHex()).toBe(0x336699)
  })

  it('instanced fabric furniture also gets the sheen material', () => {
    const home = createEmptyHome()
    for (let i = 0; i < 3; i++) {
      home.furniture.push({
        id: `c${i}`, name: 'Chair', catalogId: 'chair-a',
        x: i * 60, y: 0, angleDeg: 0,
        width: 40, depth: 40, height: 80,
        elevation: 0, color: 0xff0000,
      })
    }
    const scene = buildScene(home)
    const instanced = instancedFurnitureMeshes(scene)[0]!
    const mat = instanced.material as THREE.MeshPhysicalMaterial
    expect(mat).toBeInstanceOf(THREE.MeshPhysicalMaterial)
    expect(mat.sheen).toBeGreaterThan(0)
  })
})

describe('lightIntensity option (Ticket 5b: general lighting controls)', () => {
  function lightsOf(scene: THREE.Scene): THREE.Light[] {
    const lights: THREE.Light[] = []
    scene.traverse((obj) => {
      if (obj instanceof THREE.Light) lights.push(obj)
    })
    return lights
  }

  it('defaults to unchanged (multiplier 1) intensities', () => {
    const home = createEmptyHome()
    const scene = buildScene(home)
    const defaultIntensities = lightsOf(scene).map((l) => l.intensity)
    const scene2 = buildScene(home, { lightIntensity: 1 })
    const explicit = lightsOf(scene2).map((l) => l.intensity)
    expect(defaultIntensities).toEqual(explicit)
  })

  it('scales every light intensity by the given multiplier', () => {
    const home = createEmptyHome()
    const base = lightsOf(buildScene(home)).map((l) => l.intensity)
    const doubled = lightsOf(buildScene(home, { lightIntensity: 2 })).map((l) => l.intensity)
    expect(doubled.length).toBe(base.length)
    for (let i = 0; i < base.length; i++) {
      expect(doubled[i]).toBeCloseTo(base[i]! * 2, 6)
    }
  })

  it('zero multiplier zeroes out every light', () => {
    const home = createEmptyHome()
    const lights = lightsOf(buildScene(home, { lightIntensity: 0 }))
    expect(lights.length).toBeGreaterThan(0)
    for (const l of lights) expect(l.intensity).toBe(0)
  })
})

describe('exterior cladding material (Ticket 5c)', () => {
  it('wall meshes get a MeshPhysicalMaterial with a clearcoat lobe, not the old flat MeshStandardMaterial', () => {
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 300, yEnd: 0,
      thickness: 15, leftSideColor: 0xd2d2d2,
    })
    const scene = buildScene(home)
    const mesh = wallMeshes(scene)[0]!
    expect(mesh.material).toBeInstanceOf(THREE.MeshPhysicalMaterial)
    const mat = mesh.material as THREE.MeshPhysicalMaterial
    expect(mat.clearcoat).toBeGreaterThan(0)
    expect(mat.color.getHex()).toBe(0xd2d2d2)
    expect(mat.roughness).toBeCloseTo(0.7, 6)
    expect(mat.metalness).toBe(0)
  })

  it('a custom leftSideColor still comes through the cladding material unchanged', () => {
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 300, yEnd: 0,
      thickness: 15, leftSideColor: 0x224466,
    })
    const scene = buildScene(home)
    const mesh = wallMeshes(scene)[0]!
    expect((mesh.material as THREE.MeshPhysicalMaterial).color.getHex()).toBe(0x224466)
  })
})

describe('ground rendering', () => {
  it('an untextured ground gets per-vertex color variation (grass/snow look), not a single flat color', () => {
    const home = createEmptyHome()
    const scene = buildScene(home)
    let ground: THREE.Mesh | undefined
    scene.traverse((obj) => {
      if (obj.name === 'ground') ground = obj as THREE.Mesh
    })
    expect(ground).toBeDefined()
    const material = ground!.material as THREE.MeshStandardMaterial
    expect(material.vertexColors).toBe(true)
    const colorAttr = ground!.geometry.getAttribute('color')
    expect(colorAttr).toBeDefined()
    // Not every vertex identical — real variation, not a uniform tint.
    const first = [colorAttr.getX(0), colorAttr.getY(0), colorAttr.getZ(0)]
    let sawDifference = false
    for (let i = 1; i < colorAttr.count; i++) {
      if (colorAttr.getX(i) !== first[0] || colorAttr.getY(i) !== first[1] || colorAttr.getZ(i) !== first[2]) {
        sawDifference = true
        break
      }
    }
    expect(sawDifference).toBe(true)
  })

  it('a textured ground (groundTextureId set) does not get vertex-color variation', () => {
    __seedTextureCache('concrete.png', new THREE.Texture())
    try {
      const home = createEmptyHome()
      home.environment.groundTextureId = 'concrete'
      const scene = buildScene(home)
      let ground: THREE.Mesh | undefined
      scene.traverse((obj) => {
        if (obj.name === 'ground') ground = obj as THREE.Mesh
      })
      const material = ground!.material as THREE.MeshStandardMaterial
      expect(material.vertexColors).toBe(false)
    } finally {
      __clearTextureCache()
    }
  })
})

// ── T1: instanced furniture rendering ───────────────────────────────────────

function instancedFurnitureMeshes(scene: THREE.Scene): THREE.InstancedMesh[] {
  const meshes: THREE.InstancedMesh[] = []
  scene.traverse((obj) => {
    if (obj instanceof THREE.InstancedMesh && obj.name.startsWith('furniture-instanced-')) {
      meshes.push(obj)
    }
  })
  return meshes
}

describe('instanced furniture rendering (T1)', () => {
  function chair(id: string, x: number, overrides: Partial<Furniture> = {}): Furniture {
    return {
      id, name: 'Chair', catalogId: 'chair-a',
      x, y: 0, angleDeg: 0,
      width: 40, depth: 40, height: 80,
      elevation: 0, color: 0xff0000,
      ...overrides,
    }
  }

  it('20 identical pieces render as one InstancedMesh with 20 instances', () => {
    const home = createEmptyHome()
    for (let i = 0; i < 20; i++) home.furniture.push(chair(`c${i}`, i * 60))
    const scene = buildScene(home)
    const instanced = instancedFurnitureMeshes(scene)
    expect(instanced.length).toBe(1)
    expect(instanced[0]!.count).toBe(20)
    // No leftover individual meshes for grouped pieces
    expect(furnitureMeshes(scene).length).toBe(0)
  })

  it('instance matrices match furnitureMesh placement (floor + half-height, Y rotation)', () => {
    const home = createEmptyHome()
    for (let i = 0; i < 5; i++) {
      home.furniture.push({ ...chair(`c${i}`, i * 100), angleDeg: i * 30 })
    }
    const scene = buildScene(home)
    const mesh = instancedFurnitureMeshes(scene)[0]!
    const matrix = new THREE.Matrix4()
    const pos = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix)
      matrix.decompose(pos, quat, scale)
      expect(pos.x).toBeCloseTo(i * 100, 6)
      expect(pos.y).toBeCloseTo(0, 6) // level 0 + elevation 0; half-height is baked in geometry
      expect(pos.z).toBeCloseTo(0, 6)
      expect(quat.angleTo(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(i * 30)),
      )).toBeCloseTo(0, 6)
      // Geometry carries the half-height lift: box spans [0, height] in Y.
      const geomBox = new THREE.Box3().setFromBufferAttribute(
        mesh.geometry.getAttribute('position') as THREE.BufferAttribute,
      )
      expect(geomBox.min.y).toBeCloseTo(0, 6)
      expect(geomBox.max.y).toBeCloseTo(80, 6)
    }
  })

  it('selected pieces stay individual meshes with selection tint', () => {
    const home = createEmptyHome()
    for (let i = 0; i < 5; i++) home.furniture.push(chair(`c${i}`, i * 60))
    home.selection = ['c2']
    const scene = buildScene(home)
    const instanced = instancedFurnitureMeshes(scene)
    expect(instanced.length).toBe(1)
    expect(instanced[0]!.count).toBe(4)
    const individual = furnitureMeshes(scene)
    expect(individual.length).toBe(1)
    expect(individual[0]!.name).toBe('furniture:c2')
    for (const m of meshEmissives(individual[0]!)) {
      expect(m.hex).toBe(SELECTION_EMISSIVE_COLOR)
    }
  })

  it('pieces with differing dimensions are not instanced', () => {
    const home = createEmptyHome()
    home.furniture.push(chair('a', 0))
    home.furniture.push({ ...chair('b', 100), width: 50 })
    const scene = buildScene(home)
    expect(instancedFurnitureMeshes(scene).length).toBe(0)
    expect(furnitureMeshes(scene).length).toBe(2)
  })

  it('pieces with a GLB modelPath are never instanced', () => {
    const home = createEmptyHome()
    home.furniture.push({ ...chair('a', 0), modelPath: 'models/chair.glb' })
    home.furniture.push({ ...chair('b', 100), modelPath: 'models/chair.glb' })
    const scene = buildScene(home)
    expect(instancedFurnitureMeshes(scene).length).toBe(0)
    expect(furnitureMeshes(scene).length).toBe(2)
  })

  it('invisible pieces are excluded from groups and instance counts', () => {
    const home = createEmptyHome()
    for (let i = 0; i < 4; i++) home.furniture.push(chair(`c${i}`, i * 60))
    home.furniture.push({ ...chair('hidden', 300), visible: false })
    const scene = buildScene(home)
    const instanced = instancedFurnitureMeshes(scene)
    expect(instanced.length).toBe(1)
    expect(instanced[0]!.count).toBe(4)
  })
})

// ── M66: selecting furniture must not permanently tint shared model materials ─
//
// Root cause: Object3D.clone() shares material references with the cached GLB.
// tintEmissive() mutated that one shared material in place, blue-tinting every
// other instance of the same catalog model permanently. Fixed by cloning each
// material per-instance in addModel() before any highlight mutation.

/** Build a fake cached catalog model: a group with meshes sharing one material. */
function fakeCatalogModel(): THREE.Group {
  const group = new THREE.Group()
  const sharedBox = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff }),
  )
  group.add(sharedBox)
  const sharedSphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 8, 8),
    // Reuse the SAME material instance (as a real GLB cache would) to prove
    // per-instance cloning breaks the shared reference.
    sharedBox.material as THREE.MeshStandardMaterial,
  )
  group.add(sharedSphere)
  return group
}

/** Collect emissive state from all materials on a single mesh (handles arrays). */
function meshEmissives(mesh: THREE.Mesh): Array<{ hex: number; intensity: number }> {
  const out: Array<{ hex: number; intensity: number }> = []
  for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
    const std = m as THREE.MeshStandardMaterial
    out.push({ hex: std.emissive.getHex(), intensity: std.emissiveIntensity })
  }
  return out
}

/**
 * Gather emissives from every mesh descendant of each `furniture:*` root,
 * including the root's own material AND all child-model sub-mesh materials.
 * This catches the actual M66 bug: child sub-meshes sharing a cached material.
 */
function allFurnitureEmissives(scene: THREE.Scene): Map<string, Array<{ hex: number; intensity: number }>> {
  const map = new Map<string, Array<{ hex: number; intensity: number }>>()
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.name.startsWith('furniture:')) {
      const id = obj.name.slice('furniture:'.length)
      const mats = meshEmissives(obj)
      obj.traverse((child) => {
        if (child !== obj && child instanceof THREE.Mesh) {
          mats.push(...meshEmissives(child))
        }
      })
      map.set(id, mats)
    }
  })
  return map
}

function furnitureWithModel(id: string, modelPath: string) {
  return {
    id, name: 'Bookshelf', modelPath,
    x: 0, y: 0, angleDeg: 0,
    width: 100, depth: 40, height: 200,
    elevation: 0,
  }
}

describe('furniture selection material isolation (M66)', () => {
  const MODEL_URL = 'assets/bookshelf.glb'

  function makeScenes(selected: string[]) {
    const home = createEmptyHome()
    home.furniture.push(furnitureWithModel('A', 'bookshelf.glb'))
    home.furniture.push(furnitureWithModel('B', 'bookshelf.glb'))
    home.selection = selected
    return buildScene(home, { modelUrlResolver: (p) => `assets/${p}` })
  }

  it('clones cached model materials per-instance (no shared mutation)', () => {
    __seedModelCache(MODEL_URL, fakeCatalogModel())
    const scene = makeScenes([])
    const emissives = allFurnitureEmissives(scene)
    expect(emissives.size).toBe(2)

    // Fresh instance materials must not be the shared cache material reference.
    for (const [, mats] of emissives) {
      for (const m of mats) {
        expect(m.hex).toBe(0x000000)
      }
    }
  })

  it('child sub-mesh material references differ between instances', () => {
    __seedModelCache(MODEL_URL, fakeCatalogModel())
    const scene = makeScenes([])
    const matsA: THREE.Material[] = []
    const matsB: THREE.Material[] = []
    scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return
      if (obj.name === 'furniture:A' || obj.name === 'furniture:B') {
        const id = obj.name.slice('furniture:'.length)
        const dest = id === 'A' ? matsA : matsB
        obj.traverse((child) => {
          if (child !== obj && child instanceof THREE.Mesh) {
            const m = child.material
            if (Array.isArray(m)) dest.push(...m)
            else dest.push(m)
          }
        })
      }
    })
    expect(matsA.length).toBeGreaterThan(0)
    expect(matsB.length).toBe(matsA.length)
    // Every corresponding material must be a distinct object instance.
    for (let i = 0; i < matsA.length; i++) {
      expect(matsA[i]).not.toBe(matsB[i])
    }
  })

  it("selecting one instance leaves the other exactly black", () => {
    __seedModelCache(MODEL_URL, fakeCatalogModel())
    const scene = makeScenes(['A'])
    const emissives = allFurnitureEmissives(scene)
    const a = emissives.get('A')!
    const b = emissives.get('B')!
    for (const m of a) expect(m.hex).toBe(SELECTION_EMISSIVE_COLOR)
    for (const m of b) {
      expect(m.hex).toBe(0x000000)
      expect(m.intensity).toBe(0)
    }
  })

  it('deselecting returns the previously-selected material to black', () => {
    __seedModelCache(MODEL_URL, fakeCatalogModel())
    let scene = makeScenes(['A'])
    expect(allFurnitureEmissives(scene).get('A')![0]!.hex).toBe(SELECTION_EMISSIVE_COLOR)
    scene = makeScenes([])
    for (const [, mats] of allFurnitureEmissives(scene)) {
      for (const m of mats) {
        expect(m.hex).toBe(0x000000)
      }
    }
  })

  it('selecting A then B never leaves A tinted (implicit deselect)', () => {
    __seedModelCache(MODEL_URL, fakeCatalogModel())
    let scene = makeScenes(['A'])
    expect(allFurnitureEmissives(scene).get('A')![0]!.hex).toBe(SELECTION_EMISSIVE_COLOR)
    scene = makeScenes(['B'])
    const emissives = allFurnitureEmissives(scene)
    for (const m of emissives.get('A')!) {
      expect(m.hex).toBe(0x000000)
      expect(m.intensity).toBe(0)
    }
    for (const m of emissives.get('B')!) {
      expect(m.hex).toBe(SELECTION_EMISSIVE_COLOR)
    }
  })
})

// ── T2: delta updates ────────────────────────────────────────────────────────

describe('delta updates (T2)', () => {
  function sofa(id: string, x: number, y: number, overrides: Partial<Furniture> = {}): Furniture {
    return {
      id, name: 'Sofa',
      x, y, angleDeg: 0,
      width: 200, depth: 80, height: 90,
      elevation: 0,
      ...overrides,
    }
  }

  function straightWall(id: string, x1: number, y1: number, x2: number, y2: number): import('../core/home').Wall {
    return { id, xStart: x1, yStart: y1, xEnd: x2, yEnd: y2, thickness: 15, leftSideColor: 0xd2d2d2 }
  }

  function namedMeshes(scene: THREE.Scene, prefix: string): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = []
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.name.startsWith(prefix)) meshes.push(obj)
    })
    return meshes
  }

  it('single furniture move applies matrix-only (geometry identity preserved)', () => {
    const home = createEmptyHome()
    // Distinct colors keep these out of T1 instancing groups (≥2 identical only).
    home.furniture.push(sofa('f1', 100, 100, { color: 0xff0000 }))
    home.furniture.push(sofa('f2', 400, 100, { color: 0x00ff00 }))
    const scene = buildScene(home)
    const before = scene.getObjectByName('furniture:f1') as THREE.Mesh
    const geometryBefore = before.geometry

    const moved = { ...home.furniture[0]!, x: 300, y: 250, angleDeg: 45 }
    const updates = computeSceneUpdates(home, { ...home, furniture: [moved, home.furniture[1]!] })
    expect(updates.length).toBe(1)
    expect(updates[0]!.type).toBe('furniture-update')
    expect(isTransformOnlyFurnitureChange(home.furniture[0]!, moved)).toBe(true)

    const ok = applySceneUpdate(scene, updates[0]!, { ...home, furniture: [moved, home.furniture[1]!] }, home)
    expect(ok).toBe(true)
    expect(before.geometry).toBe(geometryBefore) // no geometry rebuild
    expect(before.position.x).toBe(300)
    expect(before.position.z).toBe(250)
    expect(before.rotation.y).toBeCloseTo(Math.PI / 4, 10)
  })

  it('moving an instanced group member rewrites only its instance matrix', () => {
    const home = createEmptyHome()
    for (let i = 0; i < 5; i++) {
      home.furniture.push({
        ...sofa(`c${i}`, i * 100, 0),
        catalogId: 'sofa-a', color: 0xff0000,
        angleDeg: 0,
      })
    }
    const scene = buildScene(home)
    let mesh: THREE.InstancedMesh | undefined
    scene.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) mesh = o
    })
    expect(mesh).toBeDefined()
    const countBefore = mesh!.count
    const geometryBefore = mesh!.geometry

    const moved = { ...home.furniture[2]!, x: 999, y: 555, angleDeg: 90 }
    const newHome = { ...home, furniture: home.furniture.map((f) => (f.id === 'c2' ? moved : f)) }
    const updates = computeSceneUpdates(home, newHome)
    expect(updates.length).toBe(1)
    const ok = applySceneUpdate(scene, updates[0]!, newHome, home)
    expect(ok).toBe(true)

    expect(mesh!.count).toBe(countBefore) // no rebuild
    expect(mesh!.geometry).toBe(geometryBefore)
    const matrix = new THREE.Matrix4()
    mesh!.getMatrixAt(2, matrix)
    const pos = new THREE.Vector3()
    matrix.decompose(pos, new THREE.Quaternion(), new THREE.Vector3())
    expect(pos.x).toBe(999)
    expect(pos.z).toBe(555) // plan Y maps to world Z; world Y is elevation
  })

  it('non-transform furniture change (color) is not matrix-only → fallback', () => {
    const home = createEmptyHome()
    home.furniture.push(sofa('f1', 100, 100))
    const changed = { ...home.furniture[0]!, color: 0x00ff00 }
    expect(isTransformOnlyFurnitureChange(home.furniture[0]!, changed)).toBe(false)
    const scene = buildScene(home)
    const updates = computeSceneUpdates(home, { ...home, furniture: [changed] })
    expect(updates[0]!.type).toBe('furniture-update')
    expect(applySceneUpdate(scene, updates[0]!, { ...home, furniture: [changed] }, home)).toBe(false)
  })

  it('wall edit rebuilds wall geometry but leaves furniture untouched', () => {
    const home = createEmptyHome()
    home.walls.push(straightWall('wA', 0, 0, 100, 0))
    home.walls.push(straightWall('wB', 100, 0, 100, 100))
    home.furniture.push(sofa('f1', 300, 300))
    const scene = buildScene(home)
    const furnitureBefore = scene.getObjectByName('furniture:f1')
    const wallMeshesBefore = namedMeshes(scene, 'wall:')

    const movedA = { ...home.walls[0]!, xEnd: 200 }
    const newHome = { ...home, walls: [movedA, home.walls[1]!] }
    const updates = computeSceneUpdates(home, newHome)
    expect(updates.length).toBe(1)
    expect(updates[0]!.type).toBe('wall-update')

    const ok = applySceneUpdate(scene, updates[0]!, newHome, home)
    expect(ok).toBe(true)

    // Furniture identical object — untouched.
    expect(scene.getObjectByName('furniture:f1')).toBe(furnitureBefore)
    // Wall meshes are NEW objects (rebuilt), same count.
    const wallMeshesAfter = namedMeshes(scene, 'wall:')
    expect(wallMeshesAfter.length).toBe(wallMeshesBefore.length)
    for (const after of wallMeshesAfter) {
      expect(wallMeshesBefore.some((b) => b === after)).toBe(false)
    }
  })

  it('wall edit also rebuilds the neighbor sharing the moved endpoint', () => {
    const home = createEmptyHome()
    home.walls.push(straightWall('wA', 0, 0, 100, 0))
    home.walls.push(straightWall('wB', 100, 0, 100, 100))
    const scene = buildScene(home)

    const movedA = { ...home.walls[0]!, xEnd: 200 }
    const newHome = { ...home, walls: [movedA, home.walls[1]!] }
    const ok = applySceneUpdate(scene, computeSceneUpdates(home, newHome)[0]!, newHome, home)
    expect(ok).toBe(true)

    // Neighbor wB's mitered joint must have been recomputed: new geometry
    // reaching the shared corner at (100, 0) — both old and new outlines
    // include it, so assert wB has fresh mesh objects (rebuilt), not reused.
    const wallB = namedMeshes(scene, 'wall:wB')
    expect(wallB.length).toBeGreaterThan(0)
  })

  it('room edit rebuilds room geometry but leaves walls and furniture untouched', () => {
    const home = createEmptyHome()
    home.walls.push(straightWall('wA', 0, 0, 100, 0))
    home.furniture.push(sofa('f1', 300, 300))
    home.rooms.push({ id: 'r1', points: [[0, 0], [100, 0], [100, 100], [0, 100]] })
    const scene = buildScene(home)
    const roomBefore = scene.getObjectByName('room:r1')
    const furnitureBefore = scene.getObjectByName('furniture:f1')
    const wallBefore = scene.getObjectByName('wall:wA')

    const movedRoom = { ...home.rooms[0]!, points: [[10, 0], [110, 0], [110, 100], [10, 100]] as [number, number][] }
    const newHome = { ...home, rooms: [movedRoom] }
    const updates = computeSceneUpdates(home, newHome)
    expect(updates.length).toBe(1)
    expect(updates[0]!.type).toBe('room-update')

    const ok = applySceneUpdate(scene, updates[0]!, newHome)
    expect(ok).toBe(true)

    const roomAfter = scene.getObjectByName('room:r1')
    expect(roomAfter).toBeDefined()
    expect(roomAfter).not.toBe(roomBefore) // rebuilt
    expect(scene.getObjectByName('furniture:f1')).toBe(furnitureBefore)
    expect(scene.getObjectByName('wall:wA')).toBe(wallBefore)
  })

  it('two simultaneous furniture moves produce 2 updates (caller falls back)', () => {
    const home = createEmptyHome()
    home.furniture.push(sofa('f1', 100, 100))
    home.furniture.push(sofa('f2', 400, 400))
    const moved1 = { ...home.furniture[0]!, x: 150 }
    const moved2 = { ...home.furniture[1]!, y: 450 }
    const updates = computeSceneUpdates(home, {
      ...home,
      furniture: [moved1, moved2],
    })
    expect(updates.length).toBe(2)
  })

  it('single furniture move on a large scene applies in <2ms', () => {
    const home = createEmptyHome()
    for (let i = 0; i < 30; i++) {
      home.walls.push(straightWall(`w${i}`, i * 300, 0, i * 300 + 200, 0))
    }
    for (let i = 0; i < 200; i++) {
      home.furniture.push(sofa(`f${i}`, (i % 20) * 250, Math.floor(i / 20) * 250, {
        catalogId: i % 2 === 0 ? 'sofa-a' : undefined,
        color: i % 2 === 0 ? 0xff0000 : undefined,
      }))
    }
    const scene = buildScene(home)

    const moved = { ...home.furniture[7]!, x: 12345, y: -4321, angleDeg: 30 }
    const newHome = { ...home, furniture: home.furniture.map((f) => (f.id === moved.id ? moved : f)) }
    const updates = computeSceneUpdates(home, newHome)
    expect(updates.length).toBe(1)

    // Warm once, then measure — the DoD target is the steady-state frame.
    applySceneUpdate(scene, updates[0]!, newHome, home)
    const t0 = performance.now()
    const ok = applySceneUpdate(scene, updates[0]!, newHome, home)
    const elapsed = performance.now() - t0
    expect(ok).toBe(true)
    expect(elapsed).toBeLessThan(2)
  })
})

// ── Ceiling visibility tri-state (default = auto / per-view) ─────────────

describe('ceiling visibility tri-state', () => {
  const square = [[0, 0], [100, 0], [100, 100], [0, 100]] as Array<[number, number]>

  function groundLevelHome() {
    const home = createEmptyHome()
    home.levels.push({
      id: 'L0', name: 'Ground', elevation: 0,
      floorThickness: 0, height: 250, visible: true, viewable: true,
    })
    return home
  }

  it('getDefaultCeilingVisibility defaults to undefined (auto) for a fresh home', () => {
    expect(getDefaultCeilingVisibility(createEmptyHome())).toBeUndefined()
  })

  it('a room created via the engine with default preferences has no explicit ceilingVisible', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const engine = new PlanEngine(model)
    engine.createRoomFromLoop({
      walls: [],
      area: 10000,
      vertices: square.map(([x, y]) => ({ x, y })),
    })
    const room = store.getHome().rooms[0]!
    expect(room.ceilingVisible).toBeUndefined()
  })

  it('fresh room (auto) hides ceiling in interior view, shows in outside view', () => {
    const home = groundLevelHome()
    home.rooms.push({ id: 'r1', points: square, levelRef: 'L0' })

    const interior = buildScene(home)
    expect(ceilingMeshes(interior).length).toBe(0)

    const outside = buildScene(home, { isOutsideView: true })
    expect(ceilingMeshes(outside).length).toBe(1)
  })

  it('explicit ceilingVisible=true shows the ceiling even in interior view', () => {
    const home = groundLevelHome()
    home.rooms.push({ id: 'r1', points: square, levelRef: 'L0', ceilingVisible: true })
    expect(ceilingMeshes(buildScene(home)).length).toBe(1)
  })

  describe('shouldShowCeiling', () => {
    const interior = { isOutsideView: false, isBelowActiveLevel: false }
    const outside = { isOutsideView: true, isBelowActiveLevel: false }
    const below = { isOutsideView: false, isBelowActiveLevel: true }
    const room = (ceilingVisible: boolean | undefined) => ({
      id: 'r1',
      points: square,
      ceilingVisible,
    })

    it('undefined (auto): hidden in interior, shown outside and below active level', () => {
      expect(shouldShowCeiling(room(undefined), interior)).toBe(false)
      expect(shouldShowCeiling(room(undefined), outside)).toBe(true)
      expect(shouldShowCeiling(room(undefined), below)).toBe(true)
    })

    it('true is always shown, false is always hidden', () => {
      expect(shouldShowCeiling(room(true), interior)).toBe(true)
      expect(shouldShowCeiling(room(true), outside)).toBe(true)
      expect(shouldShowCeiling(room(false), interior)).toBe(false)
      expect(shouldShowCeiling(room(false), outside)).toBe(false)
    })
  })
})

describe('below-level ghost ceiling vs active floor (z-fighting regression)', () => {
  function stackedHome(): ReturnType<typeof createEmptyHome> {
    const home = createEmptyHome()
    home.levels.push(
      { id: 'level-1', name: 'Ground', elevation: 0, floorThickness: 5, height: 250, visible: true, viewable: true },
      { id: 'level-2', name: 'Upper', elevation: 250, floorThickness: 5, height: 250, visible: true, viewable: true },
    )
    for (const levelRef of ['level-1', 'level-2']) {
      home.rooms.push({
        id: `room-${levelRef}`, points: [[0, 0], [400, 0], [400, 200], [0, 200]],
        levelRef,
      })
    }
    return home
  }

  it('drops the below-level ceiling just under the active floor, never coplanar', () => {
    const scene = buildScene(stackedHome(), { activeLevel: 'level-2', isOutsideView: false })
    const floor = scene.getObjectByName('room:room-level-2') as THREE.Mesh
    const ceiling = scene.getObjectByName('ceiling:room-level-1') as THREE.Mesh
    expect(floor).toBeTruthy()
    expect(ceiling).toBeTruthy()
    // Levels stack: below ceiling would land at exactly the active floor's Y
    // and z-fight. It must sit BELOW_CEILING_Z_FIGHT_OFFSET_CM lower instead.
    expect(floor.position.y).toBe(250)
    expect(ceiling.position.y).toBe(250 - BELOW_CEILING_Z_FIGHT_OFFSET_CM)
  })

  it('leaves unrelated (non-below) ceilings at their level-top elevation', () => {
    const scene = buildScene(stackedHome(), { activeLevel: 'level-2', isOutsideView: true })
    const upperCeiling = scene.getObjectByName('ceiling:room-level-2') as THREE.Mesh
    expect(upperCeiling.position.y).toBe(500)
  })
})

describe('below-level walls vs active floor (z-fighting regression)', () => {
  function stackedHomeWithWalls(): ReturnType<typeof createEmptyHome> {
    const home = createEmptyHome()
    home.levels.push(
      { id: 'level-1', name: 'Ground', elevation: 0, floorThickness: 5, height: 250, visible: true, viewable: true },
      { id: 'level-2', name: 'Upper', elevation: 250, floorThickness: 5, height: 250, visible: true, viewable: true },
    )
    for (const levelRef of ['level-1', 'level-2']) {
      home.rooms.push({
        id: `room-${levelRef}`, points: [[0, 0], [400, 0], [400, 200], [0, 200]],
        levelRef,
      })
      home.walls.push({
        id: `wall-${levelRef}`,
        xStart: 0, yStart: 0, xEnd: 400, yEnd: 0,
        thickness: 10, levelRef,
      })
    }
    return home
  }

  it('drops the below-level wall just under the active floor, never coplanar', () => {
    const scene = buildScene(stackedHomeWithWalls(), { activeLevel: 'level-2', isOutsideView: false })
    const belowWall = scene.getObjectByName('wall:wall-level-1') as THREE.Object3D
    expect(belowWall).toBeTruthy()
    // Wall top cap would land at exactly the active floor's Y (0 + 250) and
    // z-fight with it. Dropped by BELOW_CEILING_Z_FIGHT_OFFSET_CM instead.
    expect(belowWall.position.y).toBe(-BELOW_CEILING_Z_FIGHT_OFFSET_CM)
  })

  it('leaves the active-level wall at its own elevation', () => {
    const scene = buildScene(stackedHomeWithWalls(), { activeLevel: 'level-2', isOutsideView: false })
    const activeWall = scene.getObjectByName('wall:wall-level-2') as THREE.Object3D
    expect(activeWall).toBeTruthy()
    expect(activeWall.position.y).toBe(250)
  })
})
