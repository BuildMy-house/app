import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomeModel } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import { buildScene } from '../src/view3d/scene'

const SELECTION_COLOR = 0x1a66d6
const SELECTION_INTENSITY = 0.3

/** Create a minimal fake GLTF scene: a Group containing one child Mesh with a standard material. */
function fakeGltfScene(childColor = 0xff0000): THREE.Group {
  const group = new THREE.Group()
  const child = new THREE.Mesh(
    new THREE.BoxGeometry(10, 10, 10),
    new THREE.MeshStandardMaterial({ color: childColor }),
  )
  child.name = 'child-mesh'
  group.add(child)
  return group
}

/** Collect all descendant meshes of an object. */
function descendantMeshes(obj: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = []
  obj.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh)
  })
  return meshes
}

function furnitureItem(overrides: { modelPath?: string; id?: string } = {}) {
  return {
    id: overrides.id ?? 'f-sel',
    name: 'selected-furniture',
    x: 100,
    y: 200,
    angleDeg: 45,
    width: 80,
    depth: 40,
    height: 75,
    elevation: 0,
    visible: true,
    modelPath: overrides.modelPath,
  }
}

describe('selection highlight for modeled furniture (M47)', () => {
  let spy: ReturnType<typeof vi.spyOn>

  afterEach(() => {
    spy?.mockRestore()
  })

  it('tints descendant mesh materials (not just the wrapper) when a cached model is swapped in', () => {
    const fakeScene = fakeGltfScene()
    // Pre-populate the model cache by making load succeed synchronously.
    spy = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(
      (_url, onLoad) => {
        ;(onLoad as (gltf: { scene: THREE.Group }) => void)({ scene: fakeScene })
        return undefined as unknown as void
      },
    )

    const home = {
      ...emptyHome(),
      furniture: [furnitureItem({ modelPath: 'models/m47-cached.glb' })],
      selection: ['f-sel'],
    }

    const scene = buildScene(home)
    // The wrapper mesh should have zero-size geometry (collapsed by swapInModel).
    const wrapper = findByName(scene, 'furniture:f-sel') as THREE.Mesh
    expect(wrapper).toBeDefined()
    const box = wrapper.geometry as THREE.BoxGeometry
    expect(box.parameters.width).toBe(0)
    expect(box.parameters.height).toBe(0)
    expect(box.parameters.depth).toBe(0)

    // The visible child mesh (from the fake GLTF) should be tinted.
    const children = descendantMeshes(wrapper)
    const visibleMesh = children.find((c) => c.name === 'child-mesh')
    expect(visibleMesh).toBeDefined()
    const mat = visibleMesh!.material as THREE.MeshStandardMaterial
    expect(mat.emissive.getHex()).toBe(SELECTION_COLOR)
    expect(mat.emissiveIntensity).toBe(SELECTION_INTENSITY)
  })

  it('tints child meshes added by async load when isSelected is true', async () => {
    let capturedOnLoad: ((gltf: { scene: THREE.Group }) => void) | undefined
    spy = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(
      (_url, onLoad) => {
        capturedOnLoad = onLoad as (gltf: { scene: THREE.Group }) => void
        return undefined as unknown as void
      },
    )

    const home = {
      ...emptyHome(),
      furniture: [furnitureItem({ modelPath: 'models/m47-async.glb', id: 'f-async' })],
      selection: ['f-async'],
    }

    const scene = buildScene(home)
    // Before async load: wrapper has fallback box geometry.
    const wrapper = findByName(scene, 'furniture:f-async') as THREE.Mesh
    expect(wrapper).toBeDefined()
    const origBox = wrapper.geometry as THREE.BoxGeometry
    expect(origBox.parameters.width).toBe(80)

    // Simulate async load completing.
    expect(capturedOnLoad).toBeDefined()
    capturedOnLoad!({ scene: fakeGltfScene(0x00ff00) })

    // After async swap: the new child mesh should be tinted.
    const children = descendantMeshes(wrapper)
    const visibleMesh = children.find((c) => c.name === 'child-mesh')
    expect(visibleMesh).toBeDefined()
    const mat = visibleMesh!.material as THREE.MeshStandardMaterial
    expect(mat.emissive.getHex()).toBe(SELECTION_COLOR)
    expect(mat.emissiveIntensity).toBe(SELECTION_INTENSITY)
  })

  it('does NOT tint when the furniture is not selected', () => {
    const fakeScene = fakeGltfScene()
    spy = vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(
      (_url, onLoad) => {
        ;(onLoad as (gltf: { scene: THREE.Group }) => void)({ scene: fakeScene })
        return undefined as unknown as void
      },
    )

    const home = {
      ...emptyHome(),
      furniture: [furnitureItem({ modelPath: 'models/m47-unselected.glb' })],
      selection: [], // not selected
    }

    const scene = buildScene(home)
    const wrapper = findByName(scene, 'furniture:f-sel') as THREE.Mesh
    const children = descendantMeshes(wrapper)
    const visibleMesh = children.find((c) => c.name === 'child-mesh')
    expect(visibleMesh).toBeDefined()
    const mat = visibleMesh!.material as THREE.MeshStandardMaterial
    // Default emissive is black (0x000000) and intensity 1.0 (Three.js default).
    expect(mat.emissive.getHex()).toBe(0x000000)
    expect(mat.emissiveIntensity).toBe(1)
  })

  it('tints the fallback box itself when no model is loaded (backward compat)', () => {
    const home = {
      ...emptyHome(),
      furniture: [furnitureItem()], // no modelPath
      selection: ['f-sel'],
    }

    const scene = buildScene(home)
    const wrapper = findByName(scene, 'furniture:f-sel') as THREE.Mesh
    expect(wrapper).toBeDefined()
    // Box is the visible geometry (not collapsed).
    const box = wrapper.geometry as THREE.BoxGeometry
    expect(box.parameters.width).toBe(80)
    const mat = wrapper.material as THREE.MeshStandardMaterial
    expect(mat.emissive.getHex()).toBe(SELECTION_COLOR)
    expect(mat.emissiveIntensity).toBe(SELECTION_INTENSITY)
  })

  it('tints walls by name (non-furniture selection still works)', () => {
    const home = {
      ...emptyHome(),
      walls: [
        {
          id: 'w-sel',
          xStart: 0,
          yStart: 0,
          xEnd: 200,
          yEnd: 0,
          thickness: 10,
        },
      ],
      selection: ['w-sel'],
    }

    const scene = buildScene(home)
    const wall = findByName(scene, 'wall:w-sel') as THREE.Mesh
    expect(wall).toBeDefined()
    const mat = wall.material as THREE.MeshStandardMaterial
    expect(mat.emissive.getHex()).toBe(SELECTION_COLOR)
    expect(mat.emissiveIntensity).toBe(SELECTION_INTENSITY)
  })

  it('integration: highlight works through real HomeModel/HomeStore (regression guard)', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const furniture = model.addFurniture({
      name: 'test-chair',
      x: 100,
      y: 200,
      angleDeg: 0,
      width: 50,
      depth: 50,
      height: 80,
      elevation: 0,
    })
    model.setSelection([furniture.id])
    const home = store.getHome()
    expect(home.selection).toEqual([furniture.id])
    expect(home.selection).not.toContain(`furniture:${furniture.id}`)
    const scene = buildScene(home)
    const wrapper = findByName(scene, `furniture:${furniture.id}`) as THREE.Mesh
    expect(wrapper).toBeDefined()
    const mat = wrapper.material as THREE.MeshStandardMaterial
    expect(mat.emissive.getHex()).toBe(SELECTION_COLOR)
    expect(mat.emissiveIntensity).toBe(SELECTION_INTENSITY)
  })
})

// ── helpers ──

function emptyHome() {
  return {
    schemaVersion: 1 as const,
    levels: [],
    walls: [],
    rooms: [],
    furniture: [],
    dimensionLines: [],
    labels: [],
    roofs: [],
    selection: [],
    cameras: {
      top: { x: 50, y: 1050, z: 1010, yawDeg: 180, pitchDeg: 45, fovDeg: 63, lens: 'PINHOLE' as const },
      observer: { x: 50, y: 50, z: 170, yawDeg: 315, pitchDeg: 11.25, fovDeg: 63, lens: 'PINHOLE' as const },
    },
    compass: {
      x: -100, y: 50, diameter: 100, northDirectionDeg: 0,
      latitudeRad: 0, longitudeRad: 0, visible: true,
    },
    environment: {
      skyColor: 0xcce4fc,
      groundColor: 0xa8a8a8,
      lightColor: 0xd0d0d0,
      wallsAlpha: 0,
    },
    activeTool: null,
    capabilities: { canUndo: false, canRedo: false },
  }
}

function findByName(scene: THREE.Scene, name: string): THREE.Object3D | undefined {
  let found: THREE.Object3D | undefined
  scene.traverse((o) => {
    if (!found && o.name === name) found = o
  })
  return found
}
