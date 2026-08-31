import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createEmptyHome, DEFAULT_WALL_HEIGHT_CM } from '../core/home'
import { wallOutlinePoints } from '../core/top-camera-follower'
import { buildScene, remapExtrudeUvs } from './scene'

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
    const scene = buildScene(home)
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
    const scene = buildScene(home)
    const ceilings = ceilingMeshes(scene)
    expect(ceilings.length).toBe(1)
    expect(ceilings[0]!.position.y).toBeCloseTo(400, 0)
  })

  it('room with no levelRef uses DEFAULT_WALL_HEIGHT_CM', () => {
    const home = createEmptyHome()
    home.rooms.push({
      id: 'r1', points: [[0, 0], [100, 0], [100, 100], [0, 100]],
    })
    const scene = buildScene(home)
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
