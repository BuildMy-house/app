import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { HomelyCommandHandler } from '../src/automation/homely-handler'
import { HomeModel, ModelError } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import { CameraDirector, type CameraPresetName } from '../src/view3d/cameras'
import { __seedModelCache, buildScene, furnitureMesh } from '../src/view3d/scene'
import { observeStore } from '../src/view3d/watch'
import { View3D } from '../src/view3d/view'

const rad = (deg: number): number => (deg * Math.PI) / 180

/** Closed 400x300 room (4 walls) + floor polygon + one box, on a raised level. */
function addRoomFixture(store: HomeStore): void {
  store.apply((draft) => {
    draft.levels.push({
      id: 'level-0',
      name: 'Level 0',
      elevation: 25,
      floorThickness: 10,
      height: 250,
      visible: true,
      viewable: true,
    })
    const segments = [
      { id: 'w-n', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0 },
      { id: 'w-e', xStart: 400, yStart: 0, xEnd: 400, yEnd: 300 },
      { id: 'w-s', xStart: 400, yStart: 300, xEnd: 0, yEnd: 300 },
      { id: 'w-w', xStart: 0, yStart: 300, xEnd: 0, yEnd: 0 },
    ]
    for (const segment of segments) {
      draft.walls.push({ ...segment, thickness: 7, levelRef: 'level-0' })
    }
    draft.rooms.push({
      id: 'r-1',
      points: [
        [0, 0],
        [400, 0],
        [400, 300],
        [0, 300],
      ],
      floorVisible: true,
      levelRef: 'level-0',
    })
    draft.furniture.push({
      id: 'f-1',
      name: 'table',
      x: 100,
      y: 100,
      angleDeg: 90,
      width: 80,
      depth: 40,
      height: 75,
      elevation: 0,
      visible: true,
      levelRef: 'level-0',
    })
  })
}

function indexByName(scene: THREE.Scene): Map<string, THREE.Object3D> {
  const byName = new Map<string, THREE.Object3D>()
  scene.traverse((object) => byName.set(object.name, object))
  return byName
}

/** Get the first Mesh child of a named Group (walls/rooms/furniture are now Groups). */
function meshChild(scene: THREE.Scene, name: string): THREE.Mesh {
  const obj = indexByName(scene).get(name)
  if (!obj) throw new Error(`Object "${name}" not found`)
  if ((obj as THREE.Mesh).isMesh) return obj as THREE.Mesh
  let found: THREE.Mesh | undefined
  obj.traverse((c) => { if (!found && (c as THREE.Mesh).isMesh) found = c as THREE.Mesh })
  if (!found) throw new Error(`No mesh child in "${name}"`)
  return found
}

/** Get bounding-box size and center of a mesh in world space. */
function meshBounds(mesh: THREE.Mesh): { w: number; h: number; d: number; cx: number; cy: number; cz: number } {
  mesh.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(mesh)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  return { w: size.x, h: size.y, d: size.z, cx: center.x, cy: center.y, cz: center.z }
}

function countNamed(scene: THREE.Scene, prefix: string): number {
  let count = 0
  scene.traverse((object) => {
    if (object.name.startsWith(prefix)) count += 1
  })
  return count
}

describe('buildScene', () => {
  it('renders a 4-wall room as extruded boxes matching SH3D conventions', () => {
    const store = new HomeStore()
    addRoomFixture(store)
    const scene = buildScene(store.getHome())
    const byName = indexByName(scene)

    expect(countNamed(scene, 'wall:')).toBe(4)
    expect(byName.has('wall:w-n')).toBe(true)
    expect(byName.has('wall:w-e')).toBe(true)
    expect(byName.has('wall:w-s')).toBe(true)
    expect(byName.has('wall:w-w')).toBe(true)

    // North segment: plan (0,0)->(400,0), default height fallback.
    const north = meshChild(scene, 'wall:w-n')
    expect(north.geometry).toBeInstanceOf(THREE.ExtrudeGeometry)
    const nb = meshBounds(north)
    // Mitered corners extend the bounding box into adjacent walls
    // (thickness/2 = 3.5 on each end for 90° corners → +7 total).
    expect(nb.w).toBeCloseTo(400 + 7)
    expect(nb.h).toBeCloseTo(250)
    expect(nb.d).toBeCloseTo(7)
    expect(north.position.x).toBeCloseTo(200)
    expect(nb.cy).toBeCloseTo(25 + 125)
    expect(north.position.z).toBeCloseTo(0)

    // East segment: vertical wall, no explicit rotation needed (shape handles direction).
    const east = meshChild(scene, 'wall:w-e')
    const eb = meshBounds(east)
    expect(eb.h).toBeCloseTo(250)
    expect(eb.cz).toBeCloseTo(150)
  })

  it('renders the room floor polygon flat with an up-facing normal', () => {
    const store = new HomeStore()
    addRoomFixture(store)
    const scene = buildScene(store.getHome())
    const room = meshChild(scene, 'room:r-1')

    expect(room.geometry).toBeInstanceOf(THREE.ShapeGeometry)
    expect(room.position.y).toBeCloseTo(25)
    const normal = room.geometry.getAttribute('normal')
    expect(normal.getX(0)).toBeCloseTo(0)
    expect(normal.getY(0)).toBeCloseTo(1)
    expect(normal.getZ(0)).toBeCloseTo(0)
    // Plan y spans 0..300 landing straight on world z (no mirroring).
    const position = room.geometry.getAttribute('position')
    const zs = Array.from({ length: position.count }, (_, i) => position.getZ(i))
    const xs = Array.from({ length: position.count }, (_, i) => position.getX(i))
    expect(Math.min(...zs)).toBeCloseTo(0)
    expect(Math.max(...zs)).toBeCloseTo(300)
    expect(Math.max(...xs)).toBeCloseTo(400)
  })

  it('does not create a roof when a room is closed', () => {
    const store = new HomeStore()
    addRoomFixture(store)
    const scene = buildScene(store.getHome(), { isOutsideView: true })

    expect(countNamed(scene, 'room:')).toBe(1)
    expect(countNamed(scene, 'roof:')).toBe(0)
  })

  it('renders furniture placeholder boxes with catalog dimensions', () => {
    const store = new HomeStore()
    addRoomFixture(store)
    const scene = buildScene(store.getHome())
    const table = meshChild(scene, 'furniture:f-1')

    const box = table.geometry as THREE.BoxGeometry
    expect(box.parameters.width).toBe(80)
    expect(box.parameters.height).toBe(75)
    expect(box.parameters.depth).toBe(40)
    expect(table.position.x).toBeCloseTo(100)
    expect(table.position.y).toBeCloseTo(25 + 37.5)
    expect(table.position.z).toBeCloseTo(100)
    expect(table.rotation.y).toBeCloseTo(-rad(90))
  })

  it('renders a colored box when furniture has no modelPath (backward compat)', () => {
    const store = new HomeStore()
    store.apply((draft) => {
      draft.furniture.push({
        id: 'f-box',
        name: 'plain',
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
    const mesh = meshChild(buildScene(store.getHome()), 'furniture:f-box')
    expect(mesh.geometry).toBeInstanceOf(THREE.BoxGeometry)
  })

  it('renders a box mesh for furniture with modelPath, falling back in test env', () => {
    const store = new HomeStore()
    store.apply((draft) => {
      draft.furniture.push({
        id: 'f-model',
        name: 'modeled',
        x: 0,
        y: 0,
        angleDeg: 0,
        width: 80,
        depth: 40,
        height: 75,
        elevation: 0,
        visible: true,
        modelPath: 'models/sofa.glb',
      })
    })
    // Synchronous return is the colored box; GLTF load is async and falls back
    // to the box when no model asset is available (as in the test env).
    const mesh = meshChild(buildScene(store.getHome()), 'furniture:f-model')
    expect(mesh.geometry).toBeInstanceOf(THREE.BoxGeometry)
  })

  it('triggers GLTFLoader.load only when modelPath is set', () => {
    const spy = vi
      .spyOn(GLTFLoader.prototype, 'load')
      .mockImplementation(() => undefined as unknown as void)
    const store = new HomeStore()
    store.apply((draft) => {
      draft.furniture.push({
        id: 'f-model2',
        name: 'm',
        x: 0,
        y: 0,
        angleDeg: 0,
        width: 10,
        depth: 10,
        height: 10,
        elevation: 0,
        visible: true,
        modelPath: 'models/sofa.glb',
      })
    })
    buildScene(store.getHome())
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()

    const spy2 = vi
      .spyOn(GLTFLoader.prototype, 'load')
      .mockImplementation(() => undefined as unknown as void)
    const store2 = new HomeStore()
    store2.apply((draft) => {
      draft.furniture.push({
        id: 'f-nomodel',
        name: 'n',
        x: 0,
        y: 0,
        angleDeg: 0,
        width: 10,
        depth: 10,
        height: 10,
        elevation: 0,
        visible: true,
      })
    })
    buildScene(store2.getHome())
    expect(spy2).not.toHaveBeenCalled()
    spy2.mockRestore()
  })

  it('applies environment colors and wallsAlpha transparency', () => {
    const store = new HomeStore()
    const scene = buildScene(store.getHome())
    expect(scene.background).toEqual(new THREE.Color(0xcce4fc))
    expect(indexByName(scene).has('ground')).toBe(true)

    store.apply((draft) => {
      draft.environment.wallsAlpha = 0.5
      draft.walls.push({
        id: 'w-x',
        xStart: 0,
        yStart: 0,
        xEnd: 100,
        yEnd: 0,
        thickness: 7,
      })
    })
    const wall = meshChild(buildScene(store.getHome()), 'wall:w-x')
    const material = (wall.material as THREE.MeshStandardMaterial[])[1]!
    expect(material.transparent).toBe(true)
    expect(material.opacity).toBeCloseTo(0.5)
  })

  it('renders default walls opaque: wallsAlpha is transparency, 0 = solid', () => {
    const store = new HomeStore()
    expect(store.getHome().environment.wallsAlpha).toBe(0) // SH3D default
    store.apply((draft) => {
      draft.walls.push({
        id: 'w-solid',
        xStart: 0,
        yStart: 0,
        xEnd: 100,
        yEnd: 0,
        thickness: 7,
      })
    })
    const wall = meshChild(buildScene(store.getHome()), 'wall:w-solid')
    const material = (wall.material as THREE.MeshStandardMaterial[])[1]!
    expect(material.transparent).toBe(false)
    expect(material.opacity).toBe(1)
  })
})

describe('rotated catalog model dimensions', () => {
  it('restores the app width axis for quarter-turned door models', () => {
    const url = 'https://example.test/door.glb?orientation-90-v1'
    __seedModelCache(url, new THREE.Mesh(new THREE.BoxGeometry(15, 200, 90)))
    const mesh = furnitureMesh({
      id: 'door', name: 'Door', x: 0, y: 0, angleDeg: 0,
      width: 90, depth: 15, height: 200, elevation: 0,
      doorOrWindow: true, modelPath: url,
    }, 0)
    mesh.updateMatrixWorld(true)
    const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3())
    expect(size.x).toBeCloseTo(90)
    expect(size.y).toBeCloseTo(200)
    expect(size.z).toBeCloseTo(15)
  })
})

describe('wall opening segmentation (M33)', () => {
  /** Count THREE.Mesh objects in the scene whose name matches (segment meshes). */
  function countMeshesByName(scene: THREE.Scene, name: string): number {
    let count = 0
    scene.traverse((o) => {
      if (o.name === name && (o as THREE.Mesh).isMesh) count += 1
    })
    return count
  }

  /** Collect all THREE.Mesh objects in the scene whose name matches. */
  function meshesByName(scene: THREE.Scene, name: string): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = []
    scene.traverse((o) => {
      if (o.name === name && (o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh)
    })
    return meshes
  }

  it('renders a wall with no openings as a single solid box (no regression)', () => {
    const store = new HomeStore()
    store.apply((draft) => {
      draft.walls.push({
        id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
      })
    })
    const scene = buildScene(store.getHome())
    // Exactly one mesh named wall:w1 — not segmented into a group.
    expect(countMeshesByName(scene, 'wall:w1')).toBe(1)
    const wall = meshChild(scene, 'wall:w1')
    expect(wall.geometry).toBeInstanceOf(THREE.ExtrudeGeometry)
    const wb = meshBounds(wall)
    expect(wb.w).toBeCloseTo(400)
    expect(wb.h).toBeCloseTo(250)
    expect(wb.d).toBeCloseTo(15)
  })

  it('segments a wall into multiple boxes when a door opening is present', () => {
    const store = new HomeStore()
    store.apply((draft) => {
      draft.walls.push({
        id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
      })
      draft.furniture.push({
        id: 'd1', name: 'Door',
        x: 200, y: 0, angleDeg: 0,
        width: 90, depth: 15, height: 210,
        elevation: 0,
        doorOrWindow: true, wallRef: 'w1', wallOffset: 200,
      })
    })
    const scene = buildScene(store.getHome())
    // Door (elevation=0, top=210, wall height=250): left span + lintel + right span = 3
    const meshes = meshesByName(scene, 'wall:w1')
    expect(meshes.length).toBe(3)
    for (const m of meshes) {
      expect(m.geometry).toBeInstanceOf(THREE.ExtrudeGeometry)
    }
  })

  it('produces sill and lintel boxes for window openings', () => {
    const store = new HomeStore()
    store.apply((draft) => {
      draft.walls.push({
        id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
      })
      draft.furniture.push({
        id: 'win1', name: 'Window',
        x: 200, y: 0, angleDeg: 0,
        width: 120, depth: 15, height: 120,
        elevation: 90,
        doorOrWindow: true, wallRef: 'w1', wallOffset: 200,
      })
    })
    const scene = buildScene(store.getHome())
    // Window (elevation=90, top=210, wall height=250):
    // left span + sill + lintel + right span = 4
    const meshes = meshesByName(scene, 'wall:w1')
    expect(meshes.length).toBe(4)
  })

  it('produces more child meshes for a wall with an opening than without', () => {
    const storeWith = new HomeStore()
    storeWith.apply((draft) => {
      draft.walls.push({
        id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
      })
      draft.furniture.push({
        id: 'd1', name: 'Door',
        x: 200, y: 0, angleDeg: 0,
        width: 90, depth: 15, height: 210,
        elevation: 0,
        doorOrWindow: true, wallRef: 'w1', wallOffset: 200,
      })
    })
    const storeWithout = new HomeStore()
    storeWithout.apply((draft) => {
      draft.walls.push({
        id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
      })
    })
    const withCount = countMeshesByName(buildScene(storeWith.getHome()), 'wall:w1')
    const withoutCount = countMeshesByName(buildScene(storeWithout.getHome()), 'wall:w1')
    expect(withCount).toBeGreaterThan(withoutCount)
  })

  it('places the lintel segment above the door opening height', () => {
    const store = new HomeStore()
    store.apply((draft) => {
      draft.walls.push({
        id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
      })
      draft.furniture.push({
        id: 'd1', name: 'Door',
        x: 200, y: 0, angleDeg: 0,
        width: 90, depth: 15, height: 210,
        elevation: 0,
        doorOrWindow: true, wallRef: 'w1', wallOffset: 200,
      })
    })
    const scene = buildScene(store.getHome())
    const meshes = meshesByName(scene, 'wall:w1')
    // The lintel is the shortest segment (height = 250 - 210 = 40).
    const lintel = meshes.reduce((a, b) =>
      meshBounds(a).h < meshBounds(b).h ? a : b,
    )
    const lb = meshBounds(lintel)
    expect(lb.h).toBeCloseTo(40)
    // Lintel center y = elevation + (210 + 250)/2 = 230
    expect(lb.cy).toBeCloseTo(230)
  })

  it('ignores door/window furniture attached to a different wall', () => {
    const store = new HomeStore()
    store.apply((draft) => {
      draft.walls.push({
        id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
      })
      draft.walls.push({
        id: 'w2', xStart: 0, yStart: 0, xEnd: 0, yEnd: 400, thickness: 15,
      })
      draft.furniture.push({
        id: 'd1', name: 'Door',
        x: 200, y: 0, angleDeg: 0,
        width: 90, depth: 15, height: 210,
        elevation: 0,
        doorOrWindow: true, wallRef: 'w2', wallOffset: 200,
      })
    })
    const scene = buildScene(store.getHome())
    // w1 has no openings (door is on w2) → single solid box.
    expect(countMeshesByName(scene, 'wall:w1')).toBe(1)
    // w2 is segmented.
    expect(countMeshesByName(scene, 'wall:w2')).toBe(3)
  })
})

describe('camera conventions', () => {
  it('maps the observer default through the SH3D transform', () => {
    const view = new View3D(new HomeStore())
    expect(view.director.getActivePreset()).toBe('observer')
    expect(view.camera.position.x).toBeCloseTo(50)
    expect(view.camera.position.y).toBeCloseTo(170) // eye height lives in z
    expect(view.camera.position.z).toBeCloseTo(50)
    expect(view.camera.rotation.order).toBe('YXZ')
    expect(view.camera.rotation.y).toBeCloseTo(Math.PI - rad(315))
    expect(view.camera.rotation.x).toBeCloseTo(-rad(11.25))
    expect(view.camera.fov).toBeCloseTo(63)
  })

  it('switches to the top preset with SH3D defaults', () => {
    const view = new View3D(new HomeStore())
    view.setActivePreset('top')
    expect(view.camera.position.x).toBeCloseTo(50)
    expect(view.camera.position.y).toBeCloseTo(1010)
    expect(view.camera.position.z).toBeCloseTo(1050)
    expect(view.camera.rotation.y).toBeCloseTo(Math.PI - rad(180)) // ~0
    expect(view.camera.rotation.x).toBeCloseTo(-rad(45))
  })

  it('director patches only the active camera through HomeModel', () => {
    const store = new HomeStore()
    const director = new CameraDirector(store, new HomeModel(store))

    director.setCamera({ x: 123, y: 77 })
    expect(store.getHome().cameras.observer.x).toBe(123)
    expect(store.getHome().cameras.observer.y).toBe(77)
    expect(store.getHome().cameras.top.x).toBeCloseTo(50)

    const top = director.usePreset('top')
    expect(top.fovDeg).toBe(63)
    director.setCamera({ x: 999 })
    expect(store.getHome().cameras.top.x).toBe(999)
    expect(store.getHome().cameras.observer.x).toBe(123)
  })

  it('rejects unknown presets with ModelError', () => {
    const store = new HomeStore()
    const director = new CameraDirector(store, new HomeModel(store))
    expect(() => director.usePreset('iso' as CameraPresetName)).toThrow(ModelError)
  })

  it('aims the active camera at a plan-space target', () => {
    const store = new HomeStore()
    const director = new CameraDirector(store, new HomeModel(store))

    director.lookAt({ x: 50, y: 500, z: 170 })

    expect(director.getCamera().yawDeg).toBeCloseTo(0)
    expect(director.getCamera().pitchDeg).toBeCloseTo(0)
  })

  it('frames a room and exposes camera commands', () => {
    const store = new HomeStore()
    addRoomFixture(store)
    const director = new CameraDirector(store, new HomeModel(store))
    const frame = director.fitToRoom(store.getHome(), 'r-1')

    expect(frame.center).toEqual({ x: 200, y: 20, z: 150 })
    expect(frame.state.x).not.toBe(50)
    expect(() => director.fitToRoom(store.getHome(), 'missing')).toThrow(/unknown room id/)

    const handler = new HomelyCommandHandler(store)
    const result = handler.execute('get_capabilities', {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.data as { commands: string[] }).commands).toEqual(
      expect.arrayContaining(['look_at', 'frame_scene', 'frame_room']),
    )
  })
})

describe('store watch shim', () => {
  it('notifies on apply/undo/redo/reset and not on no-op undo/redo', () => {
    const store = new HomeStore()
    const listener = vi.fn()
    const unobserve = observeStore(store, listener)

    expect(store.undo()).toBe(false)
    expect(store.redo()).toBe(false)
    expect(listener).not.toHaveBeenCalled()

    store.apply(() => undefined)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.undo()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.redo()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(3)
    store.resetToEmpty()
    expect(listener).toHaveBeenCalledTimes(4)

    unobserve()
    store.apply(() => undefined)
    expect(listener).toHaveBeenCalledTimes(4)
  })
})

describe('View3D live sync', () => {
  it('rebuilds the scene on store changes and keeps both presets working', () => {
    const store = new HomeStore()
    const view = new View3D(store)
    expect(countNamed(view.scene, 'wall:')).toBe(0)

    addRoomFixture(store)
    expect(countNamed(view.scene, 'wall:')).toBe(4)
    expect(countNamed(view.scene, 'room:')).toBe(1)
    expect(countNamed(view.scene, 'furniture:')).toBe(1)

    view.setActivePreset('top')
    expect(countNamed(view.scene, 'wall:')).toBe(4)
    // Top camera follows home contents (SH3D TopCameraState parity, B7):
    // fixture bounds center (200,150,137.5), distance 1414.21 preserved.
    expect(view.camera.position.y).toBeCloseTo(1137.5)
    expect(view.camera.position.x).toBeCloseTo(200)
    expect(view.camera.position.z).toBeCloseTo(1150)

    view.dispose()
  })
})

describe('automation camera commands', () => {
  it('advertises set_camera and camera_preset in get_capabilities', () => {
    const handler = new HomelyCommandHandler(new HomeStore())
    const result = handler.execute('get_capabilities', {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const commands = (result.data as { commands: string[] }).commands
    expect(commands).toContain('set_camera')
    expect(commands).toContain('camera_preset')
    expect(commands).toContain('look_at')
    expect(commands).toContain('frame_scene')
    expect(commands).toContain('frame_room')
  })

  it('aims, frames the scene, and frames a room through automation', () => {
    const store = new HomeStore()
    addRoomFixture(store)
    const handler = new HomelyCommandHandler(store)

    expect(handler.execute('look_at', { x: 200, y: 150, z: 0 }).ok).toBe(true)
    expect(handler.execute('frame_scene', {}).ok).toBe(true)
    const room = handler.execute('frame_room', { roomId: 'r-1' })
    expect(room.ok).toBe(true)
    if (!room.ok) return
    expect((room.data as { center: unknown }).center).toEqual({ x: 200, y: 20, z: 150 })
    expect(handler.execute('frame_room', { roomId: 'missing' })).toMatchObject({
      ok: false,
      code: 'INVALID_PARAMS',
    })
  })

  it('set_camera applies only supplied fields to the active camera', () => {
    const store = new HomeStore()
    const handler = new HomelyCommandHandler(store)

    expect(handler.execute('set_camera', { x: 123, yawDeg: 10 })).toEqual({ ok: true, data: {} })
    const observer = store.getHome().cameras.observer
    expect(observer.x).toBe(123)
    expect(observer.yawDeg).toBe(10)
    expect(observer.pitchDeg).toBeCloseTo(11.25)

    handler.execute('camera_preset', { preset: 'top' })
    expect(handler.execute('set_camera', { x: 999 })).toEqual({ ok: true, data: {} })
    expect(store.getHome().cameras.top.x).toBe(999)
    expect(store.getHome().cameras.observer.x).toBe(123)
  })

  it('camera_preset switches preset and reports the resulting camera', () => {
    const store = new HomeStore()
    const handler = new HomelyCommandHandler(store)

    const result = handler.execute('camera_preset', { preset: 'top' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const top = store.getHome().cameras.top
    expect(result.data).toEqual({
      camera: {
        x: top.x,
        y: top.y,
        z: top.z,
        yawDeg: top.yawDeg,
        pitchDeg: top.pitchDeg,
        fovDeg: top.fovDeg,
      },
    })
    // Subsequent set_camera now targets top.
    handler.execute('set_camera', { fovDeg: 70 })
    expect(store.getHome().cameras.top.fovDeg).toBe(70)
  })

  it('rejects bad params with INVALID_PARAMS', () => {
    const handler = new HomelyCommandHandler(new HomeStore())
    const badType = handler.execute('set_camera', { x: 'far' })
    expect(badType.ok).toBe(false)
    if (!badType.ok) expect(badType.code).toBe('INVALID_PARAMS')
    const nan = handler.execute('set_camera', { x: Number.NaN })
    expect(nan.ok).toBe(false)
    if (!nan.ok) expect(nan.code).toBe('INVALID_PARAMS')
    const badPreset = handler.execute('camera_preset', { preset: 'iso' })
    expect(badPreset.ok).toBe(false)
    if (!badPreset.ok) expect(badPreset.code).toBe('INVALID_PARAMS')
  })
})

describe('rendering metrics frame sampling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /**
   * The animation loop stops whenever OrbitControls stops moving, but many
   * other callbacks (texture loads, selection changes) restart it long after.
   * The first tick of a restart must not count the whole idle gap as one
   * frame's dt — that single bogus sample was corrupting fps/frameTimeP95Ms
   * in prod telemetry (frameTimeP95Ms ≈ 2000ms vs renderCpuMs ≈ 65ms).
   */
  it('does not attribute idle time between loop restarts as frame time', () => {
    const view = new View3D(new HomeStore())
    const v = view as unknown as Record<string, unknown>

    // Manual clock + rAF capture so each tick runs at a chosen timestamp.
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let queued: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      queued = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})

    // Minimal fakes for the renderer/controls the loop touches (private fields).
    v.renderer = {
      info: {
        autoReset: true,
        reset: () => {},
        render: { calls: 1, triangles: 1 },
        memory: { textures: 0 },
      },
      render: () => {},
      getPixelRatio: () => 1,
      dispose: () => {},
    }
    let moving = false
    v.controls = { update: (): boolean => moving, dispose: () => {} }

    const startLoop = (): void => (v.startAnimationLoop as () => void)()
    const tick = (): void => {
      const cb = queued
      queued = undefined
      cb?.(now)
    }

    // First restart of the session: prime the loop, run one idle tick (dt is
    // skipped via the _frameLastTime === 0 sentinel), loop stops (moving=false).
    startLoop()
    tick()
    expect(v._frameSamples as number[]).toEqual([])

    // Long idle gap (2 minutes) with the loop stopped, then a texture-load-style
    // restart and two moving ticks: post-gap first frame must be skipped, and
    // only the genuine 16ms inter-frame delta may be recorded.
    now += 120_000
    moving = true
    startLoop()
    tick() // post-restart first frame: sentinel reset → no sample
    now += 16
    tick() // genuine frame
    expect(v._frameSamples as number[]).toEqual([16])

    // Metrics derived from the samples stay in a sane range (pre-fix, the
    // 120s gap was recorded as a frame: frameTimeP95Ms ≈ 120000, fps ≈ 0.008).
    const metrics = (v.collectRenderingMetrics as () => { fps: number; frameTimeP95Ms: number })()
    expect(metrics.fps).toBeGreaterThan(30)
    expect(metrics.frameTimeP95Ms).toBeLessThan(1000)

    // dispose() touches window/document (node test env has neither).
    vi.stubGlobal('window', { removeEventListener: () => {}, addEventListener: () => {} })
    vi.stubGlobal('document', { removeEventListener: () => {}, addEventListener: () => {} })
    view.dispose()
  })

  /**
   * The app renders on demand: most redraws are a single-frame burst (store
   * edit, selection, camera command), not a continuous orbit. A single-frame
   * burst never produces an inter-frame dt, so _frameSamples stayed empty and
   * every burst-end collectRenderingMetrics() overwrote _lastMetrics with
   * fps=0 / frameTimeP95Ms=0 — prod telemetry reported zeros for every
   * rendering_metrics row. The burst must contribute the frame's own
   * production time as its sample instead.
   */
  it('records a frame-time sample for single-frame edit bursts', () => {
    const view = new View3D(new HomeStore())
    const v = view as unknown as Record<string, unknown>

    // Manual clock + rAF capture (same harness as the idle-gap test above).
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let queued: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      queued = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})

    // The fake draw costs 12ms: advancing the clock inside render() is the
    // work duration the loop measures as the frame's production time.
    v.renderer = {
      info: {
        autoReset: true,
        reset: () => {},
        render: { calls: 1, triangles: 1 },
        memory: { textures: 0 },
      },
      render: (): void => {
        now += 12
      },
      getPixelRatio: () => 1,
      dispose: () => {},
    }
    v.controls = { update: (): boolean => false, dispose: () => {} }

    const startLoop = (): void => (v.startAnimationLoop as () => void)()
    const tick = (): void => {
      const cb = queued
      queued = undefined
      cb?.(now)
    }

    // Three single-frame bursts (three edits), seconds of idle between them.
    // Each burst contributes exactly one 12ms sample; the idle gaps — which
    // the loop never spans — must not appear.
    for (let i = 0; i < 3; i++) {
      startLoop()
      tick()
      now += 2_000
    }
    expect(v._frameSamples as number[]).toEqual([12, 12, 12])

    // Pre-fix this was fps=0 / frameTimeP95Ms=0 (no samples at all).
    const metrics = (v.collectRenderingMetrics as () => { fps: number; frameTimeP95Ms: number })()
    expect(metrics.fps).toBeCloseTo(1000 / 12, 0)
    expect(metrics.frameTimeP95Ms).toBe(12)

    // dispose() touches window/document (node test env has neither).
    vi.stubGlobal('window', { removeEventListener: () => {}, addEventListener: () => {} })
    vi.stubGlobal('document', { removeEventListener: () => {}, addEventListener: () => {} })
    view.dispose()
  })
})
