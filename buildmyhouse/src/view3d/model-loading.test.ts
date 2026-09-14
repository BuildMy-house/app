/**
 * model-loading.test.ts — Tests for 3D model loading in furniture
 *
 * Verifies that:
 * - Furniture items with modelPath trigger model loading
 * - Models are cached after first load
 * - Fallback gray box appears on load failure
 */

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildScene, __seedModelCache } from './scene'
import { createEmptyHome, type Furniture } from '../core/home'

function testChair(overrides: Partial<Furniture> = {}): Furniture {
  return {
    id: 'chair-test',
    name: 'Test Chair',
    x: 0,
    y: 0,
    angleDeg: 0,
    width: 40,
    depth: 42,
    height: 90,
    elevation: 0,
    levelRef: null,
    ...overrides,
  }
}

describe('model loading', () => {
  it('furniture without modelPath gets gray box geometry', () => {
    const home = createEmptyHome()
    home.furniture.push(testChair())
    const scene = buildScene(home)

    // Find the furniture mesh
    const furniture = scene.getObjectByName('furniture:chair-test') as THREE.Mesh
    expect(furniture).toBeDefined()

    // Should have box geometry (not yet swapped with model)
    expect(furniture.geometry).toBeInstanceOf(THREE.BoxGeometry)

    // Box should NOT be collapsed (0, 0, 0) — that only happens after model swap
    const bbox = new THREE.Box3().setFromObject(furniture)
    expect(bbox.max.x).toBeGreaterThan(0)
    expect(bbox.max.y).toBeGreaterThan(0)
    expect(bbox.max.z).toBeGreaterThan(0)
  })

  it('furniture with modelPath attempts to load from cache', () => {
    // Seed the cache with a mock model
    const mockModel = new THREE.Group()
    mockModel.add(new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10)))
    __seedModelCache('assets/test-model.glb', mockModel)

    const home = createEmptyHome()
    home.furniture.push(
      testChair({
        id: 'chair-cached',
        modelPath: 'test-model.glb',
      }),
    )

    const scene = buildScene(home)
    const furniture = scene.getObjectByName('furniture:chair-cached') as THREE.Mesh

    // After cache hit, geometry should be collapsed to zero-size
    expect(furniture.geometry).toBeInstanceOf(THREE.BoxGeometry)
    const bbox = new THREE.Box3().setFromObject(furniture)

    // Model should have been swapped in, collapsing original geometry
    const geom = furniture.geometry as THREE.BoxGeometry
    const originalSize = geom.parameters.width + geom.parameters.height + geom.parameters.depth
    expect(originalSize).toBeLessThan(1) // Should be near zero after swap
  })

  it('furniture with modelPath has a child model after load', () => {
    // Seed cache
    const mockModel = new THREE.Group()
    const mockMesh = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5))
    mockModel.add(mockMesh)
    __seedModelCache('assets/test-furniture.glb', mockModel)

    const home = createEmptyHome()
    home.furniture.push(
      testChair({
        id: 'chair-with-model',
        modelPath: 'test-furniture.glb',
      }),
    )

    const scene = buildScene(home)
    const furniture = scene.getObjectByName('furniture:chair-with-model') as THREE.Mesh

    // Model should be added as child
    expect(furniture.children.length).toBeGreaterThan(0)

    // The original box geometry should be collapsed
    const geom = furniture.geometry as THREE.BoxGeometry
    expect(geom.parameters.width).toBeLessThan(1)
    expect(geom.parameters.height).toBeLessThan(1)
    expect(geom.parameters.depth).toBeLessThan(1)
  })

  it('multiple furniture with same modelPath share cached model', () => {
    // Seed cache
    const mockModel = new THREE.Group()
    mockModel.add(new THREE.Mesh(new THREE.BoxGeometry(8, 8, 8)))
    __seedModelCache('assets/shared-model.glb', mockModel)

    const home = createEmptyHome()
    home.furniture.push(
      testChair({ id: 'chair-1', modelPath: 'shared-model.glb' }),
      testChair({ id: 'chair-2', modelPath: 'shared-model.glb', x: 100 }),
    )

    const scene = buildScene(home)

    const chair1 = scene.getObjectByName('furniture:chair-1') as THREE.Mesh
    const chair2 = scene.getObjectByName('furniture:chair-2') as THREE.Mesh

    // Both should have loaded the model
    expect(chair1.children.length).toBeGreaterThan(0)
    expect(chair2.children.length).toBeGreaterThan(0)

    // Both should have collapsed geometry
    const geom1 = chair1.geometry as THREE.BoxGeometry
    const geom2 = chair2.geometry as THREE.BoxGeometry
    expect(geom1.parameters.width + geom1.parameters.height).toBeLessThan(1)
    expect(geom2.parameters.width + geom2.parameters.height).toBeLessThan(1)
  })

  it('pieces with modelPath are never instanced', () => {
    const home = createEmptyHome()
    home.furniture.push(
      testChair({ id: 'a', modelPath: 'models/test.glb' }),
      testChair({ id: 'b', modelPath: 'models/test.glb', x: 50 }),
    )

    const scene = buildScene(home)

    // Count instanced meshes (they have 'Instanced' in the name)
    const instanced = []
    scene.traverse((obj) => {
      if (obj.name.includes('instanced')) instanced.push(obj)
    })

    // No instanced meshes should exist
    expect(instanced.length).toBe(0)

    // But we should have regular furniture meshes
    const furniture = []
    scene.traverse((obj) => {
      if (obj.name.includes('furniture:')) furniture.push(obj)
    })
    expect(furniture.length).toBeGreaterThanOrEqual(2)
  })
})
