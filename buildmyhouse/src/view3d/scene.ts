import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  DEFAULT_WALL_HEIGHT_CM,
  WALL_TEXTURES,
  type Furniture,
  type Level,
  type NormalizedHomeState,
  type Room,
  type Wall,
} from '../core/home'
import { isArcWall, wallOutlinePoints } from '../core/top-camera-follower'

type Pt = [number, number]

export const DEFAULT_WALL_COLOR = 0xd2d2d2
export const DEFAULT_FLOOR_COLOR = 0xc8c8c8
export const DEFAULT_FURNITURE_COLOR = 0x9e9e9e
const DEFAULT_CEILING_COLOR = 0xf0f0f0

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

// ── Wall outline (M50/M53c) ─────────────────────────────────────────────────
//
// Reuses wallOutlinePoints() from top-camera-follower.ts for straight and arc
// walls so 2D plan bounds, 3D extrusion, and edge highlights stay identical.

/**
 * Convert a closed 2D wall outline (4 corners for straight walls, N points
 * for arc walls) into a THREE.Shape suitable for ExtrudeGeometry. The shape
 * is centered at the wall's midpoint so position/rotation on the resulting
 * mesh are straightforward.
 */
function miteredShape(
  outline: Pt[],
  midX: number,
  midY: number,
): THREE.Shape {
  const shape = new THREE.Shape()
  shape.moveTo(outline[0]![0] - midX, -(outline[0]![1] - midY))
  for (let i = 1; i < outline.length; i++) {
    shape.lineTo(outline[i]![0] - midX, -(outline[i]![1] - midY))
  }
  shape.closePath()
  return shape
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
  allWalls: Wall[],
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

  const wallTexture = wall.leftSideTextureId ? loadWallTexture(wall.leftSideTextureId) : null
  if (wallTexture) {
    material.map = wallTexture
    material.needsUpdate = true
  }

  const ux = dx / (length || 1)
  const uy = dy / (length || 1)
  const midX = (wall.xStart + wall.xEnd) / 2
  const midY = (wall.yStart + wall.yEnd) / 2

  if (isArcWall(wall)) {
    // Arc walls extrude the full curved outline. Door/window openings on a
    // curved wall are not yet supported (computeWallOpenings assumes a
    // straight segment), so the uncut extrusion is rendered — a known,
    // intentional limitation deferred to a future ticket, not a bug.
    const outline = wallOutlinePoints(wall, allWalls)
    const shape = miteredShape(outline, midX, midY)
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false })
    geometry.rotateX(-Math.PI / 2)
    if (wallTexture) remapExtrudeUvs(geometry)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `wall:${wall.id}`
    mesh.position.set(midX, elevation, midY)
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }

  const openings = computeWallOpenings(wall, furniture)

  if (openings.length === 0) {
    // No openings — single extruded mitered shape.
    const outline = wallOutlinePoints(wall, allWalls)
    const shape = miteredShape(outline, midX, midY)
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false })
    // ExtrudeGeometry builds in XY extruded along +Z.
    // Rotate -π/2 around X: Y→Z(up), Z→-Y so front face (z=depth) → +Y.
    geometry.rotateX(-Math.PI / 2)
    if (wallTexture) remapExtrudeUvs(geometry)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `wall:${wall.id}`
    mesh.position.set(midX, elevation, midY)
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }

  // Openings → segmented extruded shapes (M27 technique with mitered ends).
  const group = new THREE.Group()

  const segShape = (d1: number, d2: number): THREE.Shape => {
    const nx = -uy * wall.thickness / 2
    const ny = ux * wall.thickness / 2
    const sx = wall.xStart + ux * d1
    const sy = wall.yStart + uy * d1
    const ex = wall.xStart + ux * d2
    const ey = wall.yStart + uy * d2
    const shape = new THREE.Shape()
    shape.moveTo(sx + nx - midX, -(sy + ny - midY))
    shape.lineTo(ex + nx - midX, -(ey + ny - midY))
    shape.lineTo(ex - nx - midX, -(ey - ny - midY))
    shape.lineTo(sx - nx - midX, -(sy - ny - midY))
    shape.closePath()
    return shape
  }

  const segMesh = (d1: number, d2: number, y1: number, y2: number): THREE.Mesh => {
    const segLen = d2 - d1
    if (segLen <= 0 || y2 - y1 <= 0) return new THREE.Mesh(new THREE.BufferGeometry(), material)
    const shape = segShape(d1, d2)
    const segHeight = y2 - y1
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: segHeight, bevelEnabled: false })
    geometry.rotateX(-Math.PI / 2)
    if (wallTexture) remapExtrudeUvs(geometry)
    const m = new THREE.Mesh(geometry, material)
    m.name = `wall:${wall.id}`
    m.position.set(midX, elevation + y1, midY)
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

function wallEdges(wall: Wall, elevation: number, allWalls: Wall[]): THREE.LineSegments {
  const height = wall.height ?? DEFAULT_WALL_HEIGHT_CM
  const midX = (wall.xStart + wall.xEnd) / 2
  const midY = (wall.yStart + wall.yEnd) / 2
  const outline = wallOutlinePoints(wall, allWalls)
  const shape = miteredShape(outline, midX, midY)
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false })
  geometry.rotateX(-Math.PI / 2)
  const edges = new THREE.EdgesGeometry(geometry)
  const line = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.3 }),
  )
  line.position.set(midX, elevation, midY)
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

function ceilingMesh(room: Room, elevation: number, levels: Level[]): THREE.Mesh | null {
  if (room.ceilingVisible === false) return null
  const level = levels.find(l => l.id === room.levelRef)
  const levelHeight = level ? level.height : DEFAULT_WALL_HEIGHT_CM
  const shape = new THREE.Shape()
  room.points.forEach(([x, y], index) => {
    if (index === 0) shape.moveTo(x, -y)
    else shape.lineTo(x, -y)
  })
  const geometry = new THREE.ShapeGeometry(shape)
  geometry.rotateX(-Math.PI / 2)
  const material = new THREE.MeshStandardMaterial({
    color: DEFAULT_CEILING_COLOR,
    side: THREE.DoubleSide,
    roughness: 0.7,
    metalness: 0.0,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = `ceiling:${room.id}`
  mesh.position.y = elevation + levelHeight
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
 * Test-only hook: seed the model cache so unit tests can exercise the
 * addModel → clone-materials path synchronously without a real GLB load.
 */
export function __seedModelCache(url: string, obj: THREE.Object3D): void {
  cacheModel(url, obj)
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

// ── Wall texture loading (M52) ──────────────────────────────────────────────

const TEXTURE_TILE_CM = 100 // 1 repeat per 100 cm — documents the tiling choice
const textureCache = new Map<string, THREE.Texture | null>()
const textureLoader = new THREE.TextureLoader()

function loadWallTexture(textureId: string): THREE.Texture | null {
  const entry = WALL_TEXTURES.find((t) => t.id === textureId)
  if (!entry) return null
  const url = `assets/textures/${entry.file}`
  const cached = textureCache.get(url)
  if (cached !== undefined) return cached
  let tex: THREE.Texture | null = null
  try {
    tex = textureLoader.load(url)
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.colorSpace = THREE.SRGBColorSpace
  } catch {
    tex = null
  }
  textureCache.set(url, tex)
  return tex
}

/**
 * Remap ExtrudeGeometry UVs so textures tile by physical wall dimensions.
 * ExtrudeGeometry default UVs normalise to bounding-box [0,1], which does
 * not correspond to real-world size. Instead, we divide by the tile period
 * (TEXTURE_TILE_CM) so that each UV unit equals one tile. This is done per-
 * geometry so that shared materials (segments of an opening wall) each tile
 * at the correct density without needing per-mesh repeat overrides.
 *
 * Shape vertices' x-coordinates are projections along the wall direction
 * (miteredShape centres the outline at wall midpoint). After rotateX(-π/2),
 * shape x → geometry x → wall direction; shape y (extrude depth) → geometry
 * -z. The rotation maps extrude height to geometry y, so Y is the wall
 * height axis (0 … wallHeight) and V is derived from it.
 */
export function remapExtrudeUvs(geometry: THREE.BufferGeometry): void {
  const posAttr = geometry.getAttribute('position')
  const uvAttr = geometry.getAttribute('uv')
  if (!posAttr || !uvAttr) return
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i)
    const y = posAttr.getY(i)
    uvAttr.setXY(i, x / TEXTURE_TILE_CM, y / TEXTURE_TILE_CM)
  }
  uvAttr.needsUpdate = true
}

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
    // Object3D.clone() shares material references with the cache.
    // Clone each material per-instance so tintEmissive / clearEmissive
    // never mutates the shared cache entry or another furniture instance.
    model.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.material = Array.isArray(m.material)
          ? m.material.map((mat) => mat.clone())
          : m.material.clone()
      }
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
  // M60: mirror furniture along the local X (width) axis when modelMirrored.
  // Three.js WebGLRenderer auto-flips gl.frontFace for negative-determinant
  // world matrices, so face culling and lighting stay correct without manual
  // normal/winding correction.
  if (item.modelMirrored) mesh.scale.x = -1
  mesh.castShadow = true
  mesh.receiveShadow = true
  swapInModel(mesh, item, isSelected, onReady)
  return mesh
}

export const SELECTION_EMISSIVE_COLOR = 0x1a66d6
export const SELECTION_EMISSIVE_INTENSITY = 0.3

export function tintEmissive(object: THREE.Object3D): void {
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

export function clearEmissive(object: THREE.Object3D): void {
  object.traverse((child) => {
    if ('material' in child) {
      const mesh = child as THREE.Mesh
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        if ('emissive' in m) {
          ;(m as THREE.MeshStandardMaterial).emissive.set(0x000000)
          ;(m as THREE.MeshStandardMaterial).emissiveIntensity = 0
        }
      }
    }
  })
}

function applySelectionHighlight(scene: THREE.Scene, selectionSet: Set<string>): void {
  scene.traverse((object) => {
    const colonIdx = object.name.indexOf(':')
    if (colonIdx >= 0) {
      const id = object.name.slice(colonIdx + 1)
      if (selectionSet.has(id)) {
        tintEmissive(object)
      } else if (object.name.startsWith('furniture:')) {
        clearEmissive(object)
      }
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
  // + soft fill DirectionalLight (opposite side, no shadows) to lift shadowed faces
  const skyColor = new THREE.Color(home.environment.skyColor ?? 0xcce4fc)
  const groundColor = new THREE.Color(home.environment.groundColor ?? 0x808080)
  scene.add(new THREE.HemisphereLight(skyColor, groundColor, 1.0))
  scene.add(new THREE.AmbientLight(home.environment.lightColor ?? 0xffffff, 0.5))

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

  // Soft fill light from roughly opposite direction — lifts shadowed faces
  // without flattening the main directional shadow contrast.
  const fillLight = new THREE.DirectionalLight(dirLightColor, 0.25)
  fillLight.position.set(-300, 300, -200)
  scene.add(fillLight)

  if (home.environment.groundColor !== null) {
    const groundTexId = home.environment.groundTextureId
    const mat = groundTexId
      ? (() => {
          const tex = loadWallTexture(groundTexId)
          if (tex) {
            const size = GROUND_SIZE_CM / TEXTURE_TILE_CM
            tex.repeat.set(size, size)
            return new THREE.MeshStandardMaterial({ map: tex })
          }
          return new THREE.MeshStandardMaterial({ color: home.environment.groundColor })
        })()
      : new THREE.MeshStandardMaterial({ color: home.environment.groundColor })
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GROUND_SIZE_CM, GROUND_SIZE_CM),
      mat,
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
    const mesh = wallMesh(wall, elevationFor(wall.levelRef, elevations), wallsTransparency, home.furniture, home.walls)
    root.add(mesh)
    root.add(wallEdges(wall, elevationFor(wall.levelRef, elevations), home.walls))
  }
  for (const room of home.rooms) {
    if (room.points.length < 3) continue
    const elev = elevationFor(room.levelRef, elevations)
    if (room.floorVisible !== false) root.add(roomMesh(room, elev))
    const ceiling = ceilingMesh(room, elev, home.levels)
    if (ceiling) root.add(ceiling)
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
