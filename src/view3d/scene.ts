import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import {
  DEFAULT_WALL_HEIGHT_CM,
  WALL_TEXTURES,
  resolveTextureUrl,
  type Furniture,
  type Level,
  type NormalizedHomeState,
  type Room,
  type Roof,
  type Wall,
  type WallTextureEntry,
} from '../core/home'
import { isArcWall, wallOutlinePoints } from '../core/top-camera-follower'
import { createInstancedMesh, groupFurnitureForInstancing } from './instanced-meshes'
import { recordModelLoad, recordTextureLoad } from './asset-metrics'
import { loadViewportQuality } from './viewport-quality'

type Pt = [number, number]

const DEFAULT_WALL_COLOR = 0xd2d2d2
const DEFAULT_FLOOR_COLOR = 0xc8c8c8
const DEFAULT_FURNITURE_COLOR = 0x9e9e9e
const DEFAULT_CEILING_COLOR = 0xf0f0f0

// Ticket 5a: real glass/reflective window materials. Windows have no
// dedicated data-model discriminator (Furniture.doorOrWindow?: boolean is
// shared with doors) — reuse the same name-regex convention already used by
// src/automation/homely-handler.ts's add_door/add_window case to tell them
// apart, rather than inventing a second mechanism.
const WINDOW_GLASS_COLOR = 0xbfe3f0
const WINDOW_GLASS_ROUGHNESS = 0.05
const WINDOW_GLASS_METALNESS = 0
const WINDOW_GLASS_TRANSMISSION = 0.9
const WINDOW_GLASS_IOR = 1.5
const WINDOW_GLASS_THICKNESS = 2
const WINDOW_GLASS_TINT = 0x1a2a33

// Ticket 5b: furniture fabric materials. Soft-furnishing box fallbacks (the
// vast majority of catalog/manual furniture, which has no GLB model) render
// as a flat hard-surface MeshStandardMaterial today; a subtle sheen lobe
// (MeshPhysicalMaterial's sheen/sheenRoughness) gives them a matte, fabric-
// like look without needing per-item fabric selection UI or new schema
// fields — kept intentionally modest per the ticket's scope (materials only,
// not furniture-model fidelity).
const FABRIC_ROUGHNESS = 0.85
const FABRIC_SHEEN = 0.6
const FABRIC_SHEEN_ROUGHNESS = 0.7
const FABRIC_SHEEN_COLOR = 0xffffff

// Ticket 5b: general lighting controls. A single runtime multiplier applied
// to every light's base intensity — a presentation/viewing control (like
// showRoof), not persisted home state, so it needs no schema/export changes.
const DEFAULT_LIGHT_INTENSITY = 1

// Ticket 5c: exterior cladding material fidelity for walls (distinct from
// window glass). There is no interior/exterior wall discriminator in the
// data model (Wall has no room-adjacency reference, and Room has no wall
// reference — walls and rooms are independent geometry, SweetHome3D-style),
// so per-wall exterior detection would require real polygon adjacency
// analysis — a materially bigger lift than this ticket's siblings. Kept
// modest instead: every wall's material becomes a MeshPhysicalMaterial with
// a subtle clearcoat lobe (weather-sealed paint/siding sheen) layered on top
// of the existing diffuse/roughness/PBR-map pipeline, which keeps working
// unmodified since MeshPhysicalMaterial is a strict superset of the
// MeshStandardMaterial properties applyMaterialTextures() already sets.
const CLADDING_CLEARCOAT = 0.15
const CLADDING_CLEARCOAT_ROUGHNESS = 0.4

const GROUND_SIZE_CM = 100_000
const GRID_SIZE_CM = 20_000
const GRID_DIVISIONS = 40

function levelElevationMap(home: NormalizedHomeState): Map<string, number> {
  const elevations = new Map<string, number>()
  for (const level of home.levels) elevations.set(level.id, level.elevation)
  return elevations
}

function elevationFor(ref: string | null | undefined, levels: Map<string, number>): number {
  if (ref === null || ref === undefined) return 0
  return levels.get(ref) ?? 0
}

/**
 * Fallback for furniture whose catalog entry never got an explicit
 * modelPath: derive one from catalogId (e.g. 'eTeks#chair' -> 'eteks-chair.glb')
 * so the model still loads instead of silently keeping the colored-box
 * placeholder. Bundled models live under assets/models/, matching
 * defaultModelUrlResolver's `assets/${modelPath}` prefixing below.
 */
function deriveModelPath(catalogId: string | null | undefined): string | null {
  if (!catalogId) return null
  const slug = catalogId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `models/${slug || 'model'}.glb`
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
function miteredShape(outline: Pt[], midX: number, midY: number): THREE.Shape {
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

function computeWallOpenings(wall: Wall, furniture: ReadonlyArray<Furniture>): WallOpening[] {
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

export function wallMesh(
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
  // Ticket 5c: exterior cladding material — MeshPhysicalMaterial + clearcoat
  // instead of a flat MeshStandardMaterial (see claddingMaterial() above).
  const material = claddingMaterial(wall.leftSideColor ?? DEFAULT_WALL_COLOR, 0.7, 0.0)
  // SH3D Wall3D.java:1522 — wallsAlpha is a TRANSPARENCY (0 = opaque).
  if (wallsTransparency > 0) {
    material.transparent = true
    material.opacity = 1 - wallsTransparency
  }

  const wallTexture = wall.leftSideTextureId
    ? applyMaterialTextures(material, wall.leftSideTextureId)
    : null

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
    if (wallTexture) {
      remapExtrudeUvs(geometry)
      if (wallTexture.aoFile) addUv2(geometry)
    }
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
    if (wallTexture) {
      remapExtrudeUvs(geometry)
      if (wallTexture.aoFile) addUv2(geometry)
    }
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
    const nx = (-uy * wall.thickness) / 2
    const ny = (ux * wall.thickness) / 2
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
    if (wallTexture) {
      remapExtrudeUvs(geometry)
      if (wallTexture.aoFile) addUv2(geometry)
    }
    const m = new THREE.Mesh(geometry, material)
    m.name = `wall:${wall.id}`
    m.position.set(midX, elevation + y1, midY)
    m.castShadow = true
    m.receiveShadow = true
    return m
  }

  const sorted = [...openings].sort(
    (a, b) => a.centerAlong - a.width / 2 - (b.centerAlong - b.width / 2),
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

export function wallEdges(wall: Wall, elevation: number, allWalls: Wall[]): THREE.LineSegments {
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
  // Named so scene-delta.ts can find and replace an edited wall's edges.
  line.name = `wall-edge:${wall.id}`
  return line
}

export function roomMesh(room: Room, elevation: number, opts?: { opacity?: number }): THREE.Mesh {
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
  if (opts?.opacity !== undefined) {
    material.transparent = true
    material.opacity = opts.opacity
  }
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = `room:${room.id}`
  mesh.position.y = elevation
  mesh.receiveShadow = true
  return mesh
}

/** Opacity used to render the floor of the level below the active one, as
 * standing-surface context under the floor being worked on. */
export const BELOW_LEVEL_FLOOR_OPACITY = 0.4
/** Transparency (SH3D-style: 0 = opaque) for walls of the level below the
 * active one — enough to read as context without blocking the active floor. */
const BELOW_LEVEL_WALL_TRANSPARENCY = 0.75

export interface CeilingVisibilityContext {
  /** Viewing the whole model from outside (no single floor being edited). */
  isOutsideView: boolean
  /** This room is on the level directly below the currently active level. */
  isBelowActiveLevel: boolean
}

/**
 * A room's ceiling is hidden by default so the active floor stays open to
 * work in, except: an explicit per-room override always wins (lets a top
 * floor opt into a visible/styled ceiling); otherwise it shows in the
 * outside/whole-model view, or when the room is the floor below the one the
 * user is editing (its ceiling doubles as the surface the active floor
 * stands on).
 */
export function shouldShowCeiling(room: Room, ctx: CeilingVisibilityContext): boolean {
  if (room.ceilingVisible === true) return true
  if (room.ceilingVisible === false) return false
  return ctx.isOutsideView || ctx.isBelowActiveLevel
}

export function ceilingMesh(room: Room, elevation: number, levels: Level[]): THREE.Mesh {
  const level = levels.find((l) => l.id === room.levelRef)
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

function roofMesh(roof: Roof, elevation: number, levelHeight: number): THREE.Mesh | null {
  if (roof.points.length < 3) return null
  const overhang = Math.max(0, roof.overhangCm)
  const xs = roof.points.map(([x]) => x)
  const zs = roof.points.map(([, z]) => z)
  const minX = Math.min(...xs) - overhang
  const maxX = Math.max(...xs) + overhang
  const minZ = Math.min(...zs) - overhang
  const maxZ = Math.max(...zs) + overhang
  const centerX = (minX + maxX) / 2
  const centerZ = (minZ + maxZ) / 2
  const halfX = Math.max(1, (maxX - minX) / 2)
  const halfZ = Math.max(1, (maxZ - minZ) / 2)
  const pitch = Math.tan(THREE.MathUtils.degToRad(Math.max(0, roof.pitchDeg)))
  const eaveY = elevation + levelHeight
  const ridgeY = eaveY + Math.min(halfX, halfZ) * pitch
  const vertices: number[] = []
  const triangle = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
  ): void => {
    vertices.push(...a, ...b, ...c)
  }
  if (roof.style === 'hip') {
    const apex: [number, number, number] = [centerX, ridgeY, centerZ]
    triangle([minX, eaveY, minZ], [maxX, eaveY, minZ], apex)
    triangle([maxX, eaveY, minZ], [maxX, eaveY, maxZ], apex)
    triangle([maxX, eaveY, maxZ], [minX, eaveY, maxZ], apex)
    triangle([minX, eaveY, maxZ], [minX, eaveY, minZ], apex)
  } else if (halfX >= halfZ) {
    const leftRidge: [number, number, number] = [minX, ridgeY, centerZ]
    const rightRidge: [number, number, number] = [maxX, ridgeY, centerZ]
    triangle([minX, eaveY, minZ], [maxX, eaveY, minZ], rightRidge)
    triangle([minX, eaveY, minZ], rightRidge, leftRidge)
    triangle([maxX, eaveY, maxZ], [minX, eaveY, maxZ], leftRidge)
    triangle([maxX, eaveY, maxZ], leftRidge, rightRidge)
  } else {
    const nearRidge: [number, number, number] = [centerX, ridgeY, minZ]
    const farRidge: [number, number, number] = [centerX, ridgeY, maxZ]
    triangle([minX, eaveY, minZ], [minX, eaveY, maxZ], farRidge)
    triangle([minX, eaveY, minZ], farRidge, nearRidge)
    triangle([maxX, eaveY, maxZ], [maxX, eaveY, minZ], nearRidge)
    triangle([maxX, eaveY, maxZ], nearRidge, farRidge)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.computeVertexNormals()
  const material = new THREE.MeshStandardMaterial({
    color: roof.color ?? 0x8b5a3c,
    roughness: 0.8,
    metalness: 0,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = `roof:${roof.id}`
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

// ── GLTF/KTX2 loader wiring (MAT-T3) ────────────────────────────────────────
//
// Every GLTFLoader site (scene model loader, catalog thumbnails, import
// validation) shares one KTX2Loader. Compressed-texture support is a
// browser/GPU property, so a single detectSupport() pass serves all contexts;
// when no live renderer is supplied, detection runs against a throwaway
// offscreen context instead of being skipped (KTX2Loader.parse throws without
// it, which used to reject valid KTX2 GLBs at import validation).

let ktx2Loader: KTX2Loader | null = null
let ktx2SupportDetected = false

function ensureKtx2Loader(renderer?: THREE.WebGLRenderer): KTX2Loader {
  if (!ktx2Loader) {
    // Served from tracked assets/ → gitignored public/assets/ via
    // `npm run assets` (same sync convention as textures/models).
    ktx2Loader = new KTX2Loader().setTranscoderPath('assets/basis/')
  }
  if (!ktx2SupportDetected) {
    try {
      const target = renderer ?? createOffscreenRenderer()
      try {
        ktx2Loader.detectSupport(target)
      } finally {
        // Dispose only the throwaway context — never the caller's renderer.
        if (!renderer) target.dispose()
      }
      ktx2SupportDetected = true
    } catch {
      // No WebGL (node/jsdom tests): KTX2 content will fail to decode; plain
      // GLBs keep working.
    }
  }
  return ktx2Loader
}

function createOffscreenRenderer(): THREE.WebGLRenderer {
  return new THREE.WebGLRenderer()
}

/**
 * Wire a GLTFLoader with the shared KTX2 compressed-texture loader. Pass a
 * renderer when one is available (thumbnail/view renderer); otherwise
 * detection falls back to an offscreen context. Idempotent and safe in
 * non-WebGL environments.
 */
export function configureGltfLoader(
  loader: GLTFLoader,
  renderer?: THREE.WebGLRenderer,
): GLTFLoader {
  try {
    loader.setKTX2Loader(ensureKtx2Loader(renderer))
  } catch {
    // KTX2 unavailable here; uncompressed GLBs still load.
  }
  return loader
}

/** Shared GLTFLoader instance (lazy so the import cost is paid only when used). */
let sharedModelLoader: GLTFLoader | null = null

function modelLoader(): GLTFLoader {
  if (!sharedModelLoader) sharedModelLoader = configureGltfLoader(new GLTFLoader())
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

export const defaultModelUrlResolver: ModelUrlResolver = (modelPath) =>
  /^https?:\/\//i.test(modelPath) ? modelPath : `assets/${modelPath}`

/** Scene-level resolver; set once per buildScene call via the options. */
let activeModelUrlResolver: ModelUrlResolver = defaultModelUrlResolver

/**
 * Run `fn` with `resolver` installed as the active model resolver (mirrors
 * buildScene's set/restore). Lets the delta path resolve modelPaths against
 * the view's resolver without a full buildScene. No-op when resolver is
 * undefined (keep whatever is active).
 */
export function withModelUrlResolver<T>(resolver: ModelUrlResolver | undefined, fn: () => T): T {
  if (!resolver) return fn()
  const previous = activeModelUrlResolver
  activeModelUrlResolver = resolver
  try {
    return fn()
  } finally {
    activeModelUrlResolver = previous
  }
}

// ── Wall texture loading (M52) ──────────────────────────────────────────────

const TEXTURE_TILE_CM = 100 // 1 repeat per 100 cm — documents the tiling choice
const textureCache = new Map<string, THREE.Texture | null>()
const textureLoader = new THREE.TextureLoader()

/**
 * Apply the persisted viewport-quality anisotropy (1–16 per tier) to a
 * texture. The setting existed in viewport-quality.ts but was never assigned
 * to any texture object (MAT-T3 gap) — this closes it. Anisotropy changes
 * require a re-upload, so set needsUpdate only when the value actually
 * changed. WebGL clamps to the GPU max at upload time.
 */
function applyAnisotropy(tex: THREE.Texture): void {
  try {
    const max = loadViewportQuality().maxAnisotropy
    if (tex.anisotropy !== max) {
      tex.anisotropy = max
      tex.needsUpdate = true
    }
  } catch {
    // No storage (headless/node tests): leave the default.
  }
}

/** Apply the quality anisotropy to every map on a material (model loading). */
function applyAnisotropyToMaterial(material: THREE.Material): void {
  const m = material as THREE.MeshStandardMaterial
  for (const tex of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.aoMap, m.emissiveMap]) {
    if (tex) applyAnisotropy(tex)
  }
}

/**
 * Load one texture file (cached by URL). `colorSpace` must be sRGB for the
 * diffuse/base-color map only — normal/roughness/metalness/AO maps are data
 * and must stay linear (NoColorSpace), a classic PBR correctness detail.
 */
function loadTextureFile(file: string, colorSpace: THREE.ColorSpace): THREE.Texture | null {
  const url = resolveTextureUrl(file)
  const cached = textureCache.get(url)
  if (cached !== undefined) {
    if (cached) recordTextureLoad(file, cached, 0, true, url)
    // Quality presets can change between rebuilds; re-check the cached texel
    // filter instead of caching a stale anisotropy forever.
    if (cached) applyAnisotropy(cached)
    return cached
  }
  let tex: THREE.Texture | null = null
  try {
    const start = performance.now()
    tex = textureLoader.load(url, () => {
      // onLoad fires after network + decode — the real load duration.
      recordTextureLoad(file, tex, performance.now() - start, false, url)
    })
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.colorSpace = colorSpace
    // generateMipmaps/minFilter keep three.js defaults (true /
    // LinearMipmapLinearFilter) — mipmap quality is deliberate, audited in
    // MAT-T3; do not disable either.
    applyAnisotropy(tex)
  } catch {
    tex = null
  }
  textureCache.set(url, tex)
  return tex
}

/** Test-only hook: seed the texture cache so unit tests can exercise the
 * PBR material wiring synchronously without real image files. */
export function __seedTextureCache(file: string, tex: THREE.Texture | null): void {
  textureCache.set(resolveTextureUrl(file), tex)
}

export function __clearTextureCache(): void {
  textureCache.clear()
}

function loadWallTexture(textureId: string): THREE.Texture | null {
  const entry = WALL_TEXTURES.find((t) => t.id === textureId)
  if (!entry) return null
  return loadTextureFile(entry.file, THREE.SRGBColorSpace)
}

function textureEntryFor(textureId: string): WallTextureEntry | null {
  return WALL_TEXTURES.find((t) => t.id === textureId) ?? null
}

/**
 * Apply a catalog entry's PBR maps + scalar defaults to a MeshStandardMaterial.
 * Missing fields leave the current values untouched, so texture-free materials
 * keep the project-wide 0.7/0.0 baseline.
 */
function applyPbrMaps(material: THREE.MeshStandardMaterial, entry: WallTextureEntry): void {
  if (entry.normalFile) {
    const t = loadTextureFile(entry.normalFile, THREE.NoColorSpace)
    if (t) material.normalMap = t
  }
  if (entry.roughnessFile) {
    const t = loadTextureFile(entry.roughnessFile, THREE.NoColorSpace)
    if (t) material.roughnessMap = t
  }
  if (entry.metalnessFile) {
    const t = loadTextureFile(entry.metalnessFile, THREE.NoColorSpace)
    if (t) material.metalnessMap = t
  }
  if (entry.aoFile) {
    const t = loadTextureFile(entry.aoFile, THREE.NoColorSpace)
    if (t) material.aoMap = t
  }
  if (entry.roughness !== undefined) material.roughness = entry.roughness
  if (entry.metalness !== undefined) material.metalness = entry.metalness
  material.needsUpdate = true
}

/**
 * three.js aoMap samples the uv2 channel; procedural geometries (extrusions,
 * boxes, planes) only carry uv. Copying uv → uv2 is the standard workaround
 * when there is no separate lightmap UV set. Without uv2 the shader samples
 * aoMap at (0,0) everywhere — a single constant corner-texel occlusion.
 */
function addUv2(geometry: THREE.BufferGeometry): void {
  if (geometry.getAttribute('uv2')) return
  const uv = geometry.getAttribute('uv')
  if (uv) geometry.setAttribute('uv2', uv)
}

/** Wire diffuse + PBR maps for a textureId-bearing material; returns the
 * catalog entry (or null) so callers can addUv2() geometries needing it. */
function applyMaterialTextures(
  material: THREE.MeshStandardMaterial,
  textureId: string,
): WallTextureEntry | null {
  const entry = textureEntryFor(textureId)
  if (!entry) return null
  const diffuse = loadWallTexture(textureId)
  if (diffuse) {
    material.map = diffuse
    material.needsUpdate = true
  }
  applyPbrMaps(material, entry)
  return entry
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
  const scale = new THREE.Vector3(item.width / size.x, item.height / size.y, item.depth / size.z)
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
function swapInModel(
  mesh: THREE.Mesh,
  item: Furniture,
  isSelected: boolean,
  onReady?: () => void,
): void {
  const modelPath = item.modelPath || deriveModelPath(item.catalogId)
  if (!modelPath) return
  const url = activeModelUrlResolver(modelPath)

  const addModel = (source: THREE.Object3D): void => {
    const model = fitModelToBox(source.clone(), item)
    // Object3D.clone() shares material references with the cache.
    // Clone each material per-instance so tintEmissive / clearEmissive
    // never mutates the shared cache entry or another furniture instance.
    model.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        if (Array.isArray(m.material)) {
          m.material.forEach(applyAnisotropyToMaterial)
          m.material = m.material.map((mat) => mat.clone())
        } else {
          applyAnisotropyToMaterial(m.material)
          m.material = m.material.clone()
        }
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
    recordModelLoad(0, true, url)
    addModel(cached)
    return
  }

  const loader = modelLoader()
  try {
    const start = performance.now()
    loader.load(
      url,
      (gltf) => {
        recordModelLoad(performance.now() - start, false, url)
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

/**
 * Windows have no dedicated data-model discriminator: Furniture.doorOrWindow
 * is shared with doors, so this mirrors the exact convention already used by
 * src/automation/homely-handler.ts's add_door/add_window case (a name regex
 * combined with the doorOrWindow flag) instead of inventing a new one.
 */
export function isWindowFurniture(item: Furniture): boolean {
  return item.doorOrWindow === true && /window/i.test(item.name)
}

/**
 * Real glass material (Ticket 5a) replacing the flat blue-box "glazing
 * placeholder": MeshPhysicalMaterial with transmission gives actual
 * refraction/see-through behavior instead of an opaque colored box.
 */
function windowGlassMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: WINDOW_GLASS_COLOR,
    roughness: WINDOW_GLASS_ROUGHNESS,
    metalness: WINDOW_GLASS_METALNESS,
    transmission: WINDOW_GLASS_TRANSMISSION,
    ior: WINDOW_GLASS_IOR,
    thickness: WINDOW_GLASS_THICKNESS,
    attenuationColor: WINDOW_GLASS_TINT,
    attenuationDistance: 100,
    transparent: true,
  })
}

/**
 * Fabric-like material (Ticket 5b) for soft-furnishing box fallbacks: a
 * sheen lobe on top of a matte base gives a woven/upholstered look instead
 * of the previous flat hard-surface MeshStandardMaterial.
 */
function fabricMaterial(color: number): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: FABRIC_ROUGHNESS,
    metalness: 0,
    sheen: FABRIC_SHEEN,
    sheenRoughness: FABRIC_SHEEN_ROUGHNESS,
    sheenColor: new THREE.Color(FABRIC_SHEEN_COLOR),
  })
}

/**
 * Exterior cladding material (Ticket 5c) for walls: a MeshPhysicalMaterial
 * with a subtle clearcoat lobe on top of the same color/roughness/metalness
 * inputs the old MeshStandardMaterial used, giving painted siding/stucco a
 * believable weather-sealed sheen instead of a completely flat diffuse
 * surface. Deliberately colour/roughness-parametrized (not hardcoded) so
 * applyMaterialTextures()'s existing per-wall texture/PBR-map pipeline keeps
 * working unmodified — this only changes the material class and adds the
 * clearcoat lobe, not the diffuse/texturing behavior.
 */
function claddingMaterial(color: number, roughness: number, metalness: number): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness,
    metalness,
    clearcoat: CLADDING_CLEARCOAT,
    clearcoatRoughness: CLADDING_CLEARCOAT_ROUGHNESS,
  })
}

export function furnitureMesh(
  item: Furniture,
  elevation: number,
  onReady?: () => void,
  isSelected = false,
): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(item.width, item.height, item.depth)
  const isWindow = isWindowFurniture(item)
  const material = isWindow
    ? windowGlassMaterial()
    : fabricMaterial(item.color ?? DEFAULT_FURNITURE_COLOR)
  if (!isWindow && item.textureId) {
    const entry = applyMaterialTextures(material, item.textureId)
    if (entry?.aoFile) addUv2(geometry)
  }
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

/**
 * Add furniture meshes to the scene root, using instanced rendering where it
 * is visually identical: pieces grouped by groupFurnitureForInstancing render
 * as ONE InstancedMesh only when every member shares the same dimensions and
 * effective color, has no GLB model (models swap in as per-mesh children),
 * and is not selected (highlight tint is per-material, so a selected piece
 * must stay an individual mesh).
 */
function addFurnitureMeshes(
  root: THREE.Group,
  furniture: readonly Furniture[],
  elevations: Map<string, number>,
  onModelReady: (() => void) | undefined,
  selectionSet: Set<string>,
): void {
  const effectiveColor = (it: Furniture): number => it.color ?? DEFAULT_FURNITURE_COLOR
  const instancedIds = new Set<string>()
  for (const group of groupFurnitureForInstancing(furniture)) {
    // Selected pieces render individually so the highlight tint stays
    // per-material; the rest of the group still instances.
    const candidates = group.items.filter((it) => !selectionSet.has(it.id))
    if (candidates.length < 2) continue
    const first = candidates[0]!
    // Windows always render individually via furnitureMesh() so they get the
    // real glass MeshPhysicalMaterial (Ticket 5a) instead of being batched
    // into a shared, non-glass InstancedMesh.
    const canInstance = candidates.every(
      (it) =>
        !it.modelPath &&
        !isWindowFurniture(it) &&
        it.width === first.width &&
        it.height === first.height &&
        it.depth === first.depth &&
        effectiveColor(it) === effectiveColor(first) &&
        (it.textureId ?? null) === (first.textureId ?? null),
    )
    if (!canInstance) continue
    // createInstancedMesh places instance origins at the floor (level +
    // item elevation); bake the centered box's half-height lift into the
    // geometry so instances occupy the same volume as furnitureMesh boxes.
    const geometry = new THREE.BoxGeometry(first.width, first.height, first.depth)
    geometry.translate(0, first.height / 2, 0)
    const material = fabricMaterial(effectiveColor(first))
    if (first.textureId) {
      const entry = applyMaterialTextures(material, first.textureId)
      if (entry?.aoFile) addUv2(geometry)
    }
    const mesh = createInstancedMesh(
      { modelPath: group.modelPath, color: group.color, items: candidates },
      geometry,
      material,
      elevations,
    )
    // No ':' in the name — pick() and applySelectionHighlight parse
    // `furniture:<id>` / `wall:<id>` names and must not match this mesh.
    mesh.name = `furniture-instanced-${group.modelPath}`
    mesh.userData.instanceFurnitureIds = candidates.map((it) => it.id)
    for (const it of candidates) instancedIds.add(it.id)
    root.add(mesh)
  }
  for (const item of furniture) {
    if (item.visible === false) continue
    if (instancedIds.has(item.id)) continue
    root.add(
      furnitureMesh(
        item,
        elevationFor(item.levelRef, elevations),
        onModelReady,
        selectionSet.has(item.id),
      ),
    )
  }
}

export const SELECTION_EMISSIVE_COLOR = 0x1a66d6
const SELECTION_EMISSIVE_INTENSITY = 0.3

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

function clearEmissive(object: THREE.Object3D): void {
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
  options?: {
    modelUrlResolver?: ModelUrlResolver
    onModelReady?: () => void
    activeLevel?: string | null
    isOutsideView?: boolean
    /** Hide every roof mesh (roof cutaway / interior-view mode). Defaults to true (roofs shown). */
    showRoof?: boolean
    /** Multiplier applied to every light's base intensity. Defaults to 1 (unchanged). */
    lightIntensity?: number
  },
): THREE.Scene {
  const previousResolver = activeModelUrlResolver
  if (options?.modelUrlResolver) activeModelUrlResolver = options.modelUrlResolver
  try {
    return buildSceneInner(
      home,
      options?.onModelReady,
      options?.activeLevel ?? null,
      options?.isOutsideView ?? false,
      options?.showRoof ?? true,
      options?.lightIntensity ?? DEFAULT_LIGHT_INTENSITY,
    )
  } finally {
    activeModelUrlResolver = previousResolver
  }
}

export function matchesLevel(levelRef: string | undefined | null, activeLevelId: string | null): boolean {
  if (activeLevelId === null) return true
  return (levelRef ?? null) === activeLevelId
}

/**
 * Id (or null for the implicit ground floor) of the level immediately below
 * `activeLevel`, or undefined when `activeLevel` is null (all levels shown)
 * or is already the lowest level (nothing below it).
 */
export function findLevelBelowId(activeLevel: string | null, levels: Level[]): string | null | undefined {
  if (activeLevel === null) return undefined
  const active = levels.find((l) => l.id === activeLevel)
  if (!active) return undefined
  let bestId: string | null = null
  let bestElevation = 0 < active.elevation ? 0 : -Infinity
  for (const level of levels) {
    if (level.id === activeLevel) continue
    if (level.elevation < active.elevation && level.elevation >= bestElevation) {
      bestId = level.id
      bestElevation = level.elevation
    }
  }
  return bestElevation === -Infinity ? undefined : bestId
}

function buildSceneInner(
  home: NormalizedHomeState,
  onModelReady?: () => void,
  activeLevel: string | null = null,
  isOutsideView = false,
  showRoof = true,
  lightIntensity = DEFAULT_LIGHT_INTENSITY,
): THREE.Scene {
  const scene = new THREE.Scene()
  if (home.environment.skyColor !== null) {
    scene.background = new THREE.Color(home.environment.skyColor)
  }

  // HemisphereLight (natural ambient) + AmbientLight (fill) + DirectionalLight (shadows)
  // + soft fill DirectionalLight (opposite side, no shadows) to lift shadowed faces
  const skyColor = new THREE.Color(home.environment.skyColor ?? 0xcce4fc)
  const groundColor = new THREE.Color(home.environment.groundColor ?? 0x808080)
  scene.add(new THREE.HemisphereLight(skyColor, groundColor, 1.0 * lightIntensity))
  scene.add(new THREE.AmbientLight(home.environment.lightColor ?? 0xffffff, 0.5 * lightIntensity))

  const dirLightColor = new THREE.Color(home.environment.lightColor ?? 0xffffff)
  const directional = new THREE.DirectionalLight(dirLightColor, 0.8 * lightIntensity)
  directional.position.set(200, 400, 300)
  directional.castShadow = true
  directional.shadow.mapSize.set(2048, 2048)
  directional.shadow.camera.near = 1
  directional.shadow.camera.far = 2000
  directional.shadow.camera.left = -5000
  directional.shadow.camera.right = 5000
  directional.shadow.camera.top = 5000
  directional.shadow.camera.bottom = -5000
  // Bias prevents shadow acne (self-shadowing) at cm-scale geometry.
  // normalBias offsets sampling along surface normals for clean floor/wall shadows.
  directional.shadow.bias = -0.001
  directional.shadow.normalBias = 2
  scene.add(directional)

  // Soft fill light from roughly opposite direction — lifts shadowed faces
  // without flattening the main directional shadow contrast.
  const fillLight = new THREE.DirectionalLight(dirLightColor, 0.25 * lightIntensity)
  fillLight.position.set(-300, 300, -200)
  scene.add(fillLight)

  if (home.environment.groundColor !== null) {
    const groundTexId = home.environment.groundTextureId
    const groundGeometry = new THREE.PlaneGeometry(GROUND_SIZE_CM, GROUND_SIZE_CM)
    const mat = groundTexId
      ? (() => {
          const tex = loadWallTexture(groundTexId)
          if (tex) {
            const size = GROUND_SIZE_CM / TEXTURE_TILE_CM
            tex.repeat.set(size, size)
            const groundMaterial = new THREE.MeshStandardMaterial({ map: tex })
            const entry = applyMaterialTextures(groundMaterial, groundTexId)
            if (entry?.aoFile) addUv2(groundGeometry)
            return groundMaterial
          }
          return new THREE.MeshStandardMaterial({ color: home.environment.groundColor })
        })()
      : new THREE.MeshStandardMaterial({ color: home.environment.groundColor })
    const ground = new THREE.Mesh(groundGeometry, mat)
    ground.rotation.x = -Math.PI / 2
    ground.name = 'ground'
    ground.receiveShadow = true
    scene.add(ground)

    // Keep the empty viewport spatially legible without competing with the
    // plan view: 5 m squares, lifted just above the ground to avoid
    // z-fighting.
    const grid = new THREE.GridHelper(GRID_SIZE_CM, GRID_DIVISIONS, 0x596773, 0x8e9aa5)
    grid.position.y = 0.5
    grid.name = 'ground-grid'
    grid.material.transparent = true
    grid.material.opacity = 0.55
    grid.material.depthTest = false
    grid.renderOrder = 1
    grid.frustumCulled = false
    scene.add(grid)
  }

  const elevations = levelElevationMap(home)
  const wallsTransparency = home.environment.wallsAlpha ?? 0
  // The level directly below the one being edited renders as ghosted
  // context — its ceiling doubles as the surface the active floor stands
  // on, instead of the active floor's rooms floating in empty space.
  const belowLevelId = findLevelBelowId(activeLevel, home.levels)

  const root = new THREE.Group()
  root.name = 'home'
  for (const wall of home.walls) {
    const isActive = matchesLevel(wall.levelRef, activeLevel)
    const isBelowActive = belowLevelId !== undefined && (wall.levelRef ?? null) === belowLevelId
    // Outside view means "step outside and look at the whole model" — every
    // level's geometry is included regardless of which floor is active.
    if (!isActive && !isBelowActive && !isOutsideView) continue
    const elev = elevationFor(wall.levelRef, elevations)
    const transparency = isBelowActive
      ? Math.max(wallsTransparency, BELOW_LEVEL_WALL_TRANSPARENCY)
      : wallsTransparency
    const mesh = wallMesh(wall, elev, transparency, home.furniture, home.walls)
    root.add(mesh)
    if (isActive) root.add(wallEdges(wall, elev, home.walls))
  }
  for (const room of home.rooms) {
    if (room.points.length < 3) continue
    const isActive = matchesLevel(room.levelRef, activeLevel)
    const isBelowActive = belowLevelId !== undefined && (room.levelRef ?? null) === belowLevelId
    if (!isActive && !isBelowActive && !isOutsideView) continue
    const elev = elevationFor(room.levelRef, elevations)
    if (isActive && room.floorVisible !== false) root.add(roomMesh(room, elev))
    else if (isBelowActive) root.add(roomMesh(room, elev, { opacity: BELOW_LEVEL_FLOOR_OPACITY }))
    else if (isOutsideView && room.floorVisible !== false) root.add(roomMesh(room, elev))
    if (shouldShowCeiling(room, { isOutsideView, isBelowActiveLevel: isBelowActive })) {
      root.add(ceilingMesh(room, elev, home.levels))
    }
  }
  for (const roof of home.roofs) {
    if (!showRoof) continue
    if (!matchesLevel(roof.levelRef, activeLevel) && !isOutsideView) continue
    const level = home.levels.find((item) => item.id === roof.levelRef)
    const mesh = roofMesh(
      roof,
      elevationFor(roof.levelRef, elevations),
      level?.height ?? DEFAULT_WALL_HEIGHT_CM,
    )
    if (mesh) root.add(mesh)
  }
  const filteredFurniture = activeLevel === null
    ? home.furniture
    : home.furniture.filter((f) => matchesLevel(f.levelRef, activeLevel))
  const selectionSet = new Set(home.selection)
  addFurnitureMeshes(root, filteredFurniture, elevations, onModelReady, selectionSet)
  scene.add(root)

  // Selection highlight (walls, rooms — furniture handled at creation time)
  if (selectionSet.size > 0) {
    applySelectionHighlight(scene, selectionSet)
  }

  scene.fog = new THREE.FogExp2(home.environment.skyColor ?? 0xcce4fc, 0.00005)
  return scene
}
