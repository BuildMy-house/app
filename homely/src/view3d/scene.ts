import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  DEFAULT_WALL_HEIGHT_CM,
  type Furniture,
  type NormalizedHomeState,
  type Room,
  type Wall,
} from '../core/home'

export const DEFAULT_WALL_COLOR = 0xd2d2d2
export const DEFAULT_FLOOR_COLOR = 0xc8c8c8
export const DEFAULT_FURNITURE_COLOR = 0x9e9e9e

const GROUND_SIZE_CM = 100_000

function levelElevationMap(home: NormalizedHomeState): Map<string, number> {
  const elevations = new Map<string, number>()
  for (const level of home.levels) elevations.set(level.id, level.elevation)
  return elevations
}

function elevationFor(ref: string | null | undefined, levels: Map<string, number>): number {
  if (ref === null || ref === undefined) return 0
  return levels.get(ref) ?? 0
}

// ── Wall opening segmentation (M33, ported from render/scene-builder.ts) ──

interface WallOpening {
  centerAlong: number
  width: number
  bottom: number
  top: number
}

function computeWallOpenings(
  wall: Wall,
  furniture: ReadonlyArray<Furniture>,
): WallOpening[] {
  const dx = wall.xEnd - wall.xStart
  const dy = wall.yEnd - wall.yStart
  const length = Math.hypot(dx, dy)
  if (length === 0) return []
  const openings: WallOpening[] = []
  for (const f of furniture) {
    if (!f.doorOrWindow || f.wallRef !== wall.id) continue
    let centerAlong: number
    if (f.wallOffset != null) {
      centerAlong = f.wallOffset
    } else {
      const t = ((f.x - wall.xStart) * dx + (f.y - wall.yStart) * dy) / (length * length)
      centerAlong = t * length
    }
    openings.push({
      centerAlong,
      width: f.width,
      bottom: f.elevation,
      top: f.elevation + f.height,
    })
  }
  return openings
}

function wallMesh(
  wall: Wall,
  elevation: number,
  wallsTransparency: number,
  furniture: ReadonlyArray<Furniture>,
): THREE.Object3D {
  const dx = wall.xEnd - wall.xStart
  const dy = wall.yEnd - wall.yStart
  const length = Math.hypot(dx, dy)
  const height = wall.height ?? DEFAULT_WALL_HEIGHT_CM
  const material = new THREE.MeshStandardMaterial({
    color: wall.leftSideColor ?? DEFAULT_WALL_COLOR,
    roughness: 0.7,
    metalness: 0.0,
  })
  // SH3D Wall3D.java:1522 — wallsAlpha is a TRANSPARENCY (0 = opaque).
  if (wallsTransparency > 0) {
    material.transparent = true
    material.opacity = 1 - wallsTransparency
  }
  const yaw = Math.atan2(dy, dx)

  const openings = computeWallOpenings(wall, furniture)

  // No openings → single solid box (identical to pre-M33 behavior).
  if (openings.length === 0) {
    const geometry = new THREE.BoxGeometry(length, height, wall.thickness)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `wall:${wall.id}`
    mesh.position.set(
      (wall.xStart + wall.xEnd) / 2,
      elevation + height / 2,
      (wall.yStart + wall.yEnd) / 2,
    )
    mesh.rotation.y = yaw
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }

  // Openings → side-span + sill + lintel boxes (M27 technique).
  const ux = dx / length
  const uy = dy / length
  const thickness = wall.thickness
  const group = new THREE.Group()

  const segMesh = (d1: number, d2: number, y1: number, y2: number): THREE.Mesh => {
    const geom = new THREE.BoxGeometry(d2 - d1, y2 - y1, thickness)
    const m = new THREE.Mesh(geom, material)
    m.name = `wall:${wall.id}`
    m.position.set(
      wall.xStart + ux * (d1 + d2) / 2,
      elevation + (y1 + y2) / 2,
      wall.yStart + uy * (d1 + d2) / 2,
    )
    m.rotation.y = yaw
    m.castShadow = true
    m.receiveShadow = true
    return m
  }

  const sorted = [...openings].sort(
    (a, b) => (a.centerAlong - a.width / 2) - (b.centerAlong - b.width / 2),
  )
  let pos = 0
  for (const op of sorted) {
    const opStart = Math.max(0, op.centerAlong - op.width / 2)
    const opEnd = Math.min(length, op.centerAlong + op.width / 2)
    if (opStart > pos) group.add(segMesh(pos, opStart, 0, height))
    if (op.bottom > 0) group.add(segMesh(opStart, opEnd, 0, op.bottom))
    if (op.top < height) group.add(segMesh(opStart, opEnd, op.top, height))
    pos = Math.max(pos, opEnd)
  }
  if (pos < length) group.add(segMesh(pos, length, 0, height))
  return group
}

function wallEdges(wall: Wall, elevation: number): THREE.LineSegments {
  const dx = wall.xEnd - wall.xStart
  const dy = wall.yEnd - wall.yStart
  const length = Math.hypot(dx, dy)
  const height = wall.height ?? DEFAULT_WALL_HEIGHT_CM
  const geometry = new THREE.BoxGeometry(length, height, wall.thickness)
  const edges = new THREE.EdgesGeometry(geometry)
  const line = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.3 }),
  )
  line.position.set(
    (wall.xStart + wall.xEnd) / 2,
    elevation + height / 2,
    (wall.yStart + wall.yEnd) / 2,
  )
  line.rotation.y = Math.atan2(dy, dx)
  return line
}

function roomMesh(room: Room, elevation: number): THREE.Mesh {
  const shape = new THREE.Shape()
  room.points.forEach(([x, y], index) => {
    if (index === 0) shape.moveTo(x, -y)
    else shape.lineTo(x, -y)
  })
  const geometry = new THREE.ShapeGeometry(shape)
  geometry.rotateX(-Math.PI / 2)
  const material = new THREE.MeshStandardMaterial({
    color: room.floorColor ?? DEFAULT_FLOOR_COLOR,
    side: THREE.DoubleSide,
    roughness: 0.7,
    metalness: 0.0,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = `room:${room.id}`
  mesh.position.y = elevation
  mesh.receiveShadow = true
  return mesh
}

/** Shared GLTFLoader instance (lazy so the import cost is paid only when used). */
let sharedModelLoader: GLTFLoader | null = null

function modelLoader(): GLTFLoader {
  if (!sharedModelLoader) sharedModelLoader = new GLTFLoader()
  return sharedModelLoader
}

/**
 * Cache of loaded GLTF scenes keyed by resolved URL. The view rebuilds the
 * whole scene on every store change (View3D.render-on-demand), and a GLTF
 * load is async — so an in-flight load used to mutate a mesh that had already
 * been detached by the next rebuild, and the model was lost (furniture stayed
 * a gray box, or vanished). Caching lets rebuilds add the model SYNCHRONOUSLY,
 * so it renders in the same frame as the rebuild with no async gap.
 */
const modelCache = new Map<string, THREE.Object3D>()

function getCachedModel(url: string): THREE.Object3D | null {
  return modelCache.get(url) ?? null
}

function cacheModel(url: string, obj: THREE.Object3D): void {
  if (!modelCache.has(url)) modelCache.set(url, obj)
}

/**
 * Resolve a furniture's modelPath to a fetchable URL. Bundled models live at
 * `assets/<modelPath>`; user-imported models may live under a different scheme
 * (blob:, custom protocol). Override via View3DOptions.modelUrlResolver.
 */
export type ModelUrlResolver = (modelPath: string) => string

export const defaultModelUrlResolver: ModelUrlResolver = (modelPath) => `assets/${modelPath}`

/** Scene-level resolver; set once per buildScene call via the options. */
let activeModelUrlResolver: ModelUrlResolver = defaultModelUrlResolver

/**
 * Scale + center a loaded model to fit the furniture's width/height/depth,
 * leaving its origin at the box center (which the parent mesh already places).
 */
function fitModelToBox(model: THREE.Object3D, item: Furniture): THREE.Object3D {
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) return model
  const scale = new THREE.Vector3(
    item.width / size.x,
    item.height / size.y,
    item.depth / size.z,
  )
  model.scale.copy(scale)
  const center = box.getCenter(new THREE.Vector3()).multiply(scale)
  model.position.sub(center)
  return model
}

/**
 * Swap a loaded GLTF model into the furniture mesh. The model is added as a
 * child of the box mesh; the box geometry is then collapsed to 0 so only the
 * model shows. On any failure (missing file, parse error, unsupported
 * environment) the colored box is kept as a visible fallback.
 *
 * `onReady` is invoked once after an async (cache-miss) load completes, so the
 * caller can trigger a re-render — without it the swapped-in model would sit
 * un-drawn until the next camera move / store change.
 */
function swapInModel(mesh: THREE.Mesh, item: Furniture, isSelected: boolean, onReady?: () => void): void {
  if (!item.modelPath) return
  const url = activeModelUrlResolver(item.modelPath)

  const addModel = (source: THREE.Object3D): void => {
    const model = fitModelToBox(source.clone(), item)
    // Mark every mesh in the subtree shared so disposeSceneObjects skips
    // disposing geometry/material that the cache still owns.
    model.traverse((o) => {
      o.userData.shared = true
    })
    mesh.geometry.dispose()
    mesh.geometry = new THREE.BoxGeometry(0, 0, 0)
    mesh.add(model)
    if (isSelected) tintEmissive(model)
  }

  const cached = getCachedModel(url)
  if (cached) {
    addModel(cached)
    return
  }

  const loader = modelLoader()
  try {
    loader.load(
      url,
      (gltf) => {
        cacheModel(url, gltf.scene)
        addModel(gltf.scene)
        onReady?.()
      },
      undefined,
      () => {
        // Load failed: keep the colored box (fallback geometry untouched).
      },
    )
  } catch {
    // Unsupported environment (e.g. Node without a DOM FileLoader) or a
    // synchronous URL error: keep the colored box.
  }
}

function furnitureMesh(item: Furniture, elevation: number, onReady?: () => void, isSelected = false): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(item.width, item.height, item.depth)
  const material = new THREE.MeshStandardMaterial({
    color: item.color ?? DEFAULT_FURNITURE_COLOR,
    roughness: 0.7,
    metalness: 0.0,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = `furniture:${item.id}`
  mesh.position.set(item.x, elevation + item.elevation + item.height / 2, item.y)
  mesh.rotation.y = THREE.MathUtils.degToRad(item.angleDeg)
  mesh.castShadow = true
  mesh.receiveShadow = true
  swapInModel(mesh, item, isSelected, onReady)
  return mesh
}

const SELECTION_EMISSIVE_COLOR = 0x1a66d6
const SELECTION_EMISSIVE_INTENSITY = 0.3

function tintEmissive(object: THREE.Object3D): void {
  object.traverse((child) => {
    if ('material' in child) {
      const mesh = child as THREE.Mesh
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        if ('emissive' in m) {
          ;(m as THREE.MeshStandardMaterial).emissive.set(SELECTION_EMISSIVE_COLOR)
          ;(m as THREE.MeshStandardMaterial).emissiveIntensity = SELECTION_EMISSIVE_INTENSITY
        }
      }
    }
  })
}

function applySelectionHighlight(scene: THREE.Scene, selectionSet: Set<string>): void {
  scene.traverse((object) => {
    const colonIdx = object.name.indexOf(':')
    if (colonIdx >= 0 && selectionSet.has(object.name.slice(colonIdx + 1))) {
      tintEmissive(object)
    }
  })
}

/** Full scene rebuild from a normalized home snapshot. Deterministic. */
export function buildScene(
  home: NormalizedHomeState,
  options?: { modelUrlResolver?: ModelUrlResolver; onModelReady?: () => void },
): THREE.Scene {
  const previousResolver = activeModelUrlResolver
  if (options?.modelUrlResolver) activeModelUrlResolver = options.modelUrlResolver
  try {
    return buildSceneInner(home, options?.onModelReady)
  } finally {
    activeModelUrlResolver = previousResolver
  }
}

function buildSceneInner(home: NormalizedHomeState, onModelReady?: () => void): THREE.Scene {
  const scene = new THREE.Scene()
  if (home.environment.skyColor !== null) {
    scene.background = new THREE.Color(home.environment.skyColor)
  }

  // HemisphereLight (natural ambient) + AmbientLight (fill) + DirectionalLight (shadows)
  const skyColor = new THREE.Color(home.environment.skyColor ?? 0xcce4fc)
  const groundColor = new THREE.Color(home.environment.groundColor ?? 0x808080)
  scene.add(new THREE.HemisphereLight(skyColor, groundColor, 0.6))
  scene.add(new THREE.AmbientLight(home.environment.lightColor ?? 0xffffff, 0.3))

  const dirLightColor = new THREE.Color(home.environment.lightColor ?? 0xffffff)
  const directional = new THREE.DirectionalLight(dirLightColor, 0.8)
  directional.position.set(200, 400, 300)
  directional.castShadow = true
  directional.shadow.mapSize.set(2048, 2048)
  directional.shadow.camera.near = 1
  directional.shadow.camera.far = 2000
  directional.shadow.camera.left = -5000
  directional.shadow.camera.right = 5000
  directional.shadow.camera.top = 5000
  directional.shadow.camera.bottom = -5000
  scene.add(directional)

  if (home.environment.groundColor !== null) {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND_SIZE_CM, GROUND_SIZE_CM),
      new THREE.MeshStandardMaterial({ color: home.environment.groundColor }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.name = 'ground'
    ground.receiveShadow = true
    scene.add(ground)
  }

  const elevations = levelElevationMap(home)
  const wallsTransparency = home.environment.wallsAlpha ?? 0

  const root = new THREE.Group()
  root.name = 'home'
  for (const wall of home.walls) {
    const mesh = wallMesh(wall, elevationFor(wall.levelRef, elevations), wallsTransparency, home.furniture)
    root.add(mesh)
    root.add(wallEdges(wall, elevationFor(wall.levelRef, elevations)))
  }
  for (const room of home.rooms) {
    if (room.floorVisible === false || room.points.length < 3) continue
    root.add(roomMesh(room, elevationFor(room.levelRef, elevations)))
  }
  const selectionSet = new Set(home.selection)
  for (const item of home.furniture) {
    if (item.visible === false) continue
    root.add(furnitureMesh(item, elevationFor(item.levelRef, elevations), onModelReady, selectionSet.has(item.id)))
  }
  scene.add(root)

  // Selection highlight (walls, rooms — furniture handled at creation time)
  if (selectionSet.size > 0) {
    applySelectionHighlight(scene, selectionSet)
  }

  scene.fog = new THREE.FogExp2(home.environment.skyColor ?? 0xcce4fc, 0.00005)
  return scene
}
