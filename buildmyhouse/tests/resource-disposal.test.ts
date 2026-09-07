import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { HomeStore } from '../src/core/store'
import { View3D } from '../src/view3d/view'

function addFurniture(store: HomeStore, id: string): void {
  store.apply((draft) => {
    draft.furniture.push({
      id,
      name: id,
      x: 0,
      y: 0,
      angleDeg: 0,
      width: 80,
      depth: 40,
      height: 75,
      elevation: 0,
      visible: true,
    })
  })
}

function addWall(store: HomeStore, id: string): void {
  store.apply((draft) => {
    draft.walls.push({
      id,
      xStart: 0,
      yStart: 0,
      xEnd: 400,
      yEnd: 0,
      thickness: 7,
    })
  })
}

function collectDisposables(scene: THREE.Scene): {
  geometries: THREE.BufferGeometry[]
  materials: THREE.Material[]
} {
  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []
  scene.traverse((object) => {
    const obj = object as THREE.Mesh | THREE.LineSegments
    if (obj.geometry) geometries.push(obj.geometry)
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const m of mats) {
      if (m) materials.push(m)
    }
  })
  return { geometries, materials }
}

describe('GPU resource disposal', () => {
  it('disposeSceneObjects disposes geometries and materials on rebuild', () => {
    const store = new HomeStore()
    addWall(store, 'w1')
    addFurniture(store, 'f1')

    const view = new View3D(store)
    const oldScene = view.scene
    const old = collectDisposables(oldScene)

    const geoSpies = old.geometries.map((g) => vi.spyOn(g, 'dispose'))
    const matSpies = old.materials.map((m) => vi.spyOn(m, 'dispose'))

    addFurniture(store, 'f2')
    view.rebuild()

    for (const spy of geoSpies) {
      expect(spy).toHaveBeenCalled()
    }
    for (const spy of matSpies) {
      expect(spy).toHaveBeenCalled()
    }

    view.dispose()
  })

  it('disposeSceneObjects disposes LineSegments (wall edges)', () => {
    const store = new HomeStore()
    addWall(store, 'w1')

    const view = new View3D(store)
    const oldScene = view.scene

    const lineSegments: THREE.LineSegments[] = []
    oldScene.traverse((obj) => {
      if ((obj as THREE.LineSegments).isLineSegments) {
        lineSegments.push(obj as THREE.LineSegments)
      }
    })
    expect(lineSegments.length).toBeGreaterThan(0)

    const geoSpies = lineSegments.map((ls) => vi.spyOn(ls.geometry, 'dispose'))
    const matSpies = lineSegments.map((ls) => {
      const mat = Array.isArray(ls.material) ? ls.material[0]! : ls.material
      return vi.spyOn(mat, 'dispose')
    })

    addWall(store, 'w2')
    view.rebuild()

    for (const spy of geoSpies) {
      expect(spy).toHaveBeenCalled()
    }
    for (const spy of matSpies) {
      expect(spy).toHaveBeenCalled()
    }

    view.dispose()
  })

  it('does NOT dispose shared (GLTF cached) resources', () => {
    const scene = new THREE.Scene()
    const sharedGeo = new THREE.BoxGeometry(1, 1, 1)
    const sharedMat = new THREE.MeshStandardMaterial()
    const sharedMesh = new THREE.Mesh(sharedGeo, sharedMat)
    sharedMesh.userData.shared = true
    sharedMesh.name = 'shared-model'
    scene.add(sharedMesh)

    const geoSpy = vi.spyOn(sharedGeo, 'dispose')
    const matSpy = vi.spyOn(sharedMat, 'dispose')

    const store = new HomeStore()
    const view = new View3D(store)
    const privateDispose = (view as unknown as { disposeSceneObjects: (s: THREE.Scene) => void }).disposeSceneObjects
    privateDispose.call(view, scene)

    expect(geoSpy).not.toHaveBeenCalled()
    expect(matSpy).not.toHaveBeenCalled()

    sharedGeo.dispose()
    sharedMat.dispose()
    view.dispose()
  })

  it('add/remove cycles return geometry count to baseline (regression guard)', () => {
    const store = new HomeStore()
    const view = new View3D(store)

    const countGeometries = (scene: THREE.Scene): number => {
      let count = 0
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) count++
      })
      return count
    }

    const baseline = countGeometries(view.scene)

    for (let i = 0; i < 10; i++) {
      addFurniture(store, `f-cycle-${i}`)
    }
    const afterAdd = countGeometries(view.scene)
    expect(afterAdd).toBeGreaterThan(baseline)

    store.apply((draft) => {
      draft.furniture = draft.furniture.filter((f) => !f.id.startsWith('f-cycle-'))
    })
    const afterRemove = countGeometries(view.scene)
    expect(afterRemove).toBe(baseline)

    view.dispose()
  })
})
