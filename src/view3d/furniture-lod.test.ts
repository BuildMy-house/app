import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  applyFurnitureLod,
  estimateApparentSizePx,
  hasTransparentMaterial,
  shouldCullFurniture,
} from './furniture-lod'

const FOV = 63
const VIEWPORT_H = 800
// worldSize that exactly fills the vertical FOV at `distance`:
// worldSize = 2 · distance · tan(fov/2)
const fillSize = (distance: number): number => 2 * distance * Math.tan(THREE.MathUtils.degToRad(FOV) / 2)

describe('estimateApparentSizePx', () => {
  it('gives the full viewport height for an object exactly filling the vertical FOV', () => {
    expect(estimateApparentSizePx(1000, fillSize(1000), FOV, VIEWPORT_H)).toBeCloseTo(VIEWPORT_H, 6)
  })

  it('scales linearly: half the size or double the distance halves the pixels', () => {
    const base = estimateApparentSizePx(1000, fillSize(1000), FOV, VIEWPORT_H)
    expect(estimateApparentSizePx(1000, fillSize(1000) / 2, FOV, VIEWPORT_H)).toBeCloseTo(base / 2, 6)
    expect(estimateApparentSizePx(2000, fillSize(1000), FOV, VIEWPORT_H)).toBeCloseTo(base / 2, 6)
  })

  it('scales linearly with viewport height for the same world geometry', () => {
    const a = estimateApparentSizePx(500, 250, FOV, 800)
    const b = estimateApparentSizePx(500, 250, FOV, 1600)
    expect(b).toBeCloseTo(a * 2, 6)
  })

  it('returns Infinity at/inside the camera plane and 0 for degenerate inputs', () => {
    expect(estimateApparentSizePx(0, 100, FOV, VIEWPORT_H)).toBe(Infinity)
    expect(estimateApparentSizePx(-5, 100, FOV, VIEWPORT_H)).toBe(Infinity)
    expect(estimateApparentSizePx(100, 0, FOV, VIEWPORT_H)).toBe(0)
    expect(estimateApparentSizePx(100, 100, 0, VIEWPORT_H)).toBe(0)
    expect(estimateApparentSizePx(100, 100, FOV, 0)).toBe(0)
  })
})

describe('shouldCullFurniture', () => {
  it('culls strictly below the threshold, keeps at/above it', () => {
    const distance = 1000
    const size = fillSize(distance) * (8 / VIEWPORT_H) // exactly 8px apparent
    expect(estimateApparentSizePx(distance, size, FOV, VIEWPORT_H)).toBeCloseTo(8, 6)
    expect(shouldCullFurniture(distance, size, FOV, VIEWPORT_H, 8)).toBe(false)
    expect(shouldCullFurniture(distance, size * 0.999, FOV, VIEWPORT_H, 8)).toBe(true)
  })

  it('a threshold of 0 disables culling entirely', () => {
    expect(shouldCullFurniture(1e9, 1, FOV, VIEWPORT_H, 0)).toBe(false)
  })
})

describe('applyFurnitureLod', () => {
  const makeCamera = (z = 0): THREE.PerspectiveCamera => {
    const camera = new THREE.PerspectiveCamera(FOV, 4 / 3, 1, 500_000)
    camera.position.set(0, 0, z)
    return camera
  }

  const furnitureAt = (id: string, z: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100))
    mesh.name = `furniture:${id}`
    mesh.position.set(0, 50, z)
    return mesh
  }

  // 10cm cube at 10km ≈ 0.65px apparent at FOV 63 / 800px — well under any threshold.
  const FAR = 10_000
  // ≈ 65px apparent — comfortably above the high-preset 4px threshold.
  const NEAR = 1_000

  it('hides far furniture, never structural meshes, and is idempotent', () => {
    const scene = new THREE.Scene()
    const wall = new THREE.Mesh(new THREE.BoxGeometry(10, 250, 1000))
    wall.name = 'wall:w1'
    wall.position.set(0, 125, FAR)
    scene.add(wall, furnitureAt('a', FAR), furnitureAt('b', NEAR))

    const hidden = new WeakSet<THREE.Object3D>()
    const stats = applyFurnitureLod(scene, makeCamera(), VIEWPORT_H, 8, 8, hidden)
    expect(stats).toEqual({ hidden: 1, restored: 0 })
    expect(wall.visible).toBe(true)
    expect(scene.getObjectByName('furniture:a')!.visible).toBe(false)
    expect(scene.getObjectByName('furniture:b')!.visible).toBe(true)

    // Second identical pass: nothing changes.
    expect(applyFurnitureLod(scene, makeCamera(), VIEWPORT_H, 8, 8, hidden)).toEqual({
      hidden: 0,
      restored: 0,
    })
  })

  it('restores furniture the pass hid once it is close again', () => {
    const scene = new THREE.Scene()
    const item = furnitureAt('a', FAR)
    scene.add(item)
    const hidden = new WeakSet<THREE.Object3D>()
    expect(applyFurnitureLod(scene, makeCamera(), VIEWPORT_H, 8, 8, hidden).hidden).toBe(1)

    // Scene-delta style move: position.set only, matrixWorld goes stale —
    // the pass must still re-evaluate from the fresh transform.
    item.position.set(0, 50, NEAR)
    const stats = applyFurnitureLod(scene, makeCamera(), VIEWPORT_H, 8, 8, hidden)
    expect(stats).toEqual({ hidden: 0, restored: 1 })
    expect(item.visible).toBe(true)
  })

  it('keeps an InstancedMesh group visible while ANY instance is large enough', () => {
    const scene = new THREE.Scene()
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(100, 100, 100), new THREE.MeshBasicMaterial(), 2)
    mesh.name = 'furniture-instanced-chair'
    mesh.userData.instanceFurnitureIds = ['a', 'b']
    const matrix = new THREE.Matrix4()
    mesh.setMatrixAt(0, matrix.makeTranslation(0, 50, NEAR))
    mesh.setMatrixAt(1, matrix.makeTranslation(0, 50, FAR))
    mesh.instanceMatrix.needsUpdate = true
    scene.add(mesh)

    const hidden = new WeakSet<THREE.Object3D>()
    applyFurnitureLod(scene, makeCamera(), VIEWPORT_H, 8, 8, hidden)
    expect(mesh.visible).toBe(true)
  })

  it('culls an InstancedMesh group whose every instance is below threshold', () => {
    const scene = new THREE.Scene()
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(100, 100, 100), new THREE.MeshBasicMaterial(), 2)
    mesh.name = 'furniture-instanced-chair'
    mesh.userData.instanceFurnitureIds = ['a', 'b']
    const matrix = new THREE.Matrix4()
    mesh.setMatrixAt(0, matrix.makeTranslation(0, 50, FAR))
    mesh.setMatrixAt(1, matrix.makeTranslation(5000, 50, FAR))
    mesh.instanceMatrix.needsUpdate = true
    scene.add(mesh)

    const hidden = new WeakSet<THREE.Object3D>()
    expect(applyFurnitureLod(scene, makeCamera(), VIEWPORT_H, 8, 8, hidden).hidden).toBe(1)
    expect(mesh.visible).toBe(false)

    // Camera approaches: whole group comes back.
    const stats = applyFurnitureLod(scene, makeCamera(FAR - NEAR), VIEWPORT_H, 8, 8, hidden)
    expect(stats).toEqual({ hidden: 0, restored: 1 })
    expect(mesh.visible).toBe(true)
  })

  it('never overrides visibility state it did not set itself', () => {
    const scene = new THREE.Scene()
    const userHidden = furnitureAt('a', NEAR)
    userHidden.visible = false
    scene.add(userHidden)

    const hidden = new WeakSet<THREE.Object3D>()
    applyFurnitureLod(scene, makeCamera(), VIEWPORT_H, 8, 8, hidden)
    expect(userHidden.visible).toBe(false) // untouched — large enough, but not ours to show
  })

  it('a threshold of 0 disables culling and unhides previously culled furniture', () => {
    const scene = new THREE.Scene()
    scene.add(furnitureAt('a', FAR))
    const hidden = new WeakSet<THREE.Object3D>()
    expect(applyFurnitureLod(scene, makeCamera(), VIEWPORT_H, 8, 8, hidden).hidden).toBe(1)
    expect(applyFurnitureLod(scene, makeCamera(), VIEWPORT_H, 0, 0, hidden)).toEqual({
      hidden: 0,
      restored: 1,
    })
    expect(scene.getObjectByName('furniture:a')!.visible).toBe(true)
  })

  it('routes transparent furniture to the higher transparent threshold', () => {
    const scene = new THREE.Scene()
    const glass = furnitureAt('glass', NEAR)
    glass.material = new THREE.MeshPhysicalMaterial({ transparent: true })
    scene.add(glass)

    const hidden = new WeakSet<THREE.Object3D>()
    // NEAR furniture is ≈65px apparent: above the 8px opaque threshold...
    expect(applyFurnitureLod(scene, makeCamera(), VIEWPORT_H, 8, 8, hidden).hidden).toBe(0)
    expect(glass.visible).toBe(true)
    // ...but below a 100px transparent threshold → culled sooner.
    expect(applyFurnitureLod(scene, makeCamera(), VIEWPORT_H, 8, 100, hidden).hidden).toBe(1)
    expect(glass.visible).toBe(false)
  })
})

describe('hasTransparentMaterial', () => {
  it('is false for plain opaque materials, true for transparent/glass ones', () => {
    const opaque = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
    expect(hasTransparentMaterial(opaque)).toBe(false)

    const transparent = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ transparent: true }),
    )
    expect(hasTransparentMaterial(transparent)).toBe(true)

    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshPhysicalMaterial({ transmission: 1 }),
    )
    expect(hasTransparentMaterial(glass)).toBe(true)

    const multiMaterial = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [
      new THREE.MeshBasicMaterial(),
      new THREE.MeshBasicMaterial({ transparent: true }),
    ])
    expect(hasTransparentMaterial(multiMaterial)).toBe(true)
  })

  it('sees through group children and checks InstancedMesh materials', () => {
    const group = new THREE.Group()
    group.add(
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ transparent: true })),
    )
    expect(hasTransparentMaterial(group)).toBe(true)

    const opaqueInstanced = new THREE.InstancedMesh(
      new THREE.BoxGeometry(100, 100, 100),
      new THREE.MeshBasicMaterial(),
      2,
    )
    expect(hasTransparentMaterial(opaqueInstanced)).toBe(false)

    const glassInstanced = new THREE.InstancedMesh(
      new THREE.BoxGeometry(100, 100, 100),
      new THREE.MeshPhysicalMaterial({ transmission: 1 }),
      2,
    )
    expect(hasTransparentMaterial(glassInstanced)).toBe(true)
  })
})
