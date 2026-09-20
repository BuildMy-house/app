/**
 * scene-delta.ts — Incremental scene graph updates for View3D.
 *
 * Instead of full `buildScene()` rebuilds on every store change, track what
 * actually changed and apply targeted updates. Avoids geometry recreation,
 * material rebinding, and camera recalculation for most edits.
 *
 * Patterns:
 *   - Wall moved/resized → update geometry, keep material
 *   - Furniture added → load model once, add to scene
 *   - Furniture deleted → remove from scene, don't rebuild
 *   - Room created/deleted → update floor/ceiling meshes
 */

import * as THREE from 'three'
import type { Wall, Furniture, Room, NormalizedHomeState } from '../core/home'
import {
  BELOW_LEVEL_FLOOR_OPACITY,
  ceilingMesh,
  findLevelBelowId,
  furnitureMesh,
  matchesLevel,
  roomMesh,
  shouldShowCeiling,
  tintEmissive,
  wallEdges,
  wallMesh,
  withModelUrlResolver,
  type ModelUrlResolver,
} from './scene'

export type SceneUpdateType =
  | 'wall-update'
  | 'wall-delete'
  | 'furniture-add'
  | 'furniture-update'
  | 'furniture-delete'
  | 'room-update'
  | 'room-delete'
  | 'level-change'
  | 'full-rebuild' // Fallback when delta isn't applicable

export interface SceneUpdate {
  type: SceneUpdateType
  wallId?: string
  wall?: Wall
  furnitureId?: string
  furniture?: Furniture
  roomId?: string
  room?: Room
  levelId?: string
  reason?: string // Debug: why this update
}

/**
 * Compute what changed between two home states.
 * Returns a list of updates needed to transform oldHome → newHome.
 */
export function computeSceneUpdates(
  oldHome: NormalizedHomeState | null,
  newHome: NormalizedHomeState,
): SceneUpdate[] {
  if (!oldHome) {
    return [{ type: 'full-rebuild', reason: 'initial' }]
  }

  const updates: SceneUpdate[] = []

  // Quick structure checks: if levels changed drastically, rebuild
  if (oldHome.levels.length !== newHome.levels.length) {
    return [{ type: 'full-rebuild', reason: 'level count changed' }]
  }

  // Track old objects by ID for change detection
  const oldWalls = new Map(oldHome.walls.map((w) => [w.id, w]))
  const newWalls = new Map(newHome.walls.map((w) => [w.id, w]))
  const oldFurniture = new Map(oldHome.furniture.map((f) => [f.id, f]))
  const newFurniture = new Map(newHome.furniture.map((f) => [f.id, f]))
  const oldRooms = new Map(oldHome.rooms.map((r) => [r.id, r]))
  const newRooms = new Map(newHome.rooms.map((r) => [r.id, r]))

  // Detect wall changes
  for (const [id, newWall] of newWalls) {
    const oldWall = oldWalls.get(id)
    if (!oldWall) {
      // New wall — would need full rebuild if complex, but rare in practice
      return [{ type: 'full-rebuild', reason: 'new wall detected' }]
    }
    if (!wallsEqual(oldWall, newWall)) {
      updates.push({ type: 'wall-update', wallId: id, wall: newWall })
    }
  }

  // Detect wall deletions
  for (const id of oldWalls.keys()) {
    if (!newWalls.has(id)) {
      updates.push({ type: 'wall-delete', wallId: id })
    }
  }

  // Detect furniture changes
  for (const [id, newFurn] of newFurniture) {
    const oldFurn = oldFurniture.get(id)
    if (!oldFurn) {
      updates.push({ type: 'furniture-add', furnitureId: id, furniture: newFurn })
    } else if (!furnitureEqual(oldFurn, newFurn)) {
      updates.push({ type: 'furniture-update', furnitureId: id, furniture: newFurn })
    }
  }

  // Detect furniture deletions
  for (const id of oldFurniture.keys()) {
    if (!newFurniture.has(id)) {
      updates.push({ type: 'furniture-delete', furnitureId: id })
    }
  }

  // Detect room changes
  for (const [id, newRoom] of newRooms) {
    const oldRoom = oldRooms.get(id)
    if (!oldRoom) {
      return [{ type: 'full-rebuild', reason: 'new room detected' }]
    }
    if (!roomsEqual(oldRoom, newRoom)) {
      updates.push({ type: 'room-update', roomId: id, room: newRoom })
    }
  }

  // Detect room deletions
  for (const id of oldRooms.keys()) {
    if (!newRooms.has(id)) {
      updates.push({ type: 'room-delete', roomId: id })
    }
  }

  // If no updates detected but we have a change, something structural changed
  if (updates.length === 0) {
    return [{ type: 'full-rebuild', reason: 'structural change detected' }]
  }

  return updates
}

/**
 * Deep equality for walls (compare all position/dimension fields).
 */
function wallsEqual(a: Wall, b: Wall): boolean {
  return (
    a.xStart === b.xStart &&
    a.yStart === b.yStart &&
    a.xEnd === b.xEnd &&
    a.yEnd === b.yEnd &&
    a.thickness === b.thickness &&
    a.arcExtent === b.arcExtent &&
    a.height === b.height &&
    a.heightAtEnd === b.heightAtEnd &&
    a.levelRef === b.levelRef &&
    a.leftSideColor === b.leftSideColor &&
    a.rightSideColor === b.rightSideColor &&
    a.leftSideTextureId === b.leftSideTextureId &&
    a.rightSideTextureId === b.rightSideTextureId
  )
}

/**
 * Deep equality for furniture (compare transform + appearance).
 */
function furnitureEqual(a: Furniture, b: Furniture): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.elevation === b.elevation &&
    a.angleDeg === b.angleDeg &&
    a.width === b.width &&
    a.depth === b.depth &&
    a.height === b.height &&
    a.pitchDeg === b.pitchDeg &&
    a.rollDeg === b.rollDeg &&
    a.color === b.color &&
    a.catalogId === b.catalogId &&
    a.name === b.name &&
    a.visible === b.visible &&
    a.movable === b.movable &&
    a.levelRef === b.levelRef &&
    a.wallRef === b.wallRef &&
    a.doorOrWindow === b.doorOrWindow
  )
}

/**
 * Deep equality for rooms (compare polygon points).
 */
function roomsEqual(a: Room, b: Room): boolean {
  if (a.points.length !== b.points.length) return false
  for (let i = 0; i < a.points.length; i++) {
    const pa = a.points[i]!
    const pb = b.points[i]!
    if (pa[0] !== pb[0] || pa[1] !== pb[1]) return false
  }
  return a.name === b.name && a.floorColor === b.floorColor && a.levelRef === b.levelRef
}

// ── Delta handlers (T2) ─────────────────────────────────────────────────────
//
// Apply ONE clear-scope update in place to a scene built by buildScene().
// Everything ambiguous (multiple changes, adds/deletes, appearance changes)
// returns false so the caller falls back to the full rebuild.

/**
 * True when a furniture change is transform-only (position + Y rotation),
 * i.e. the delta path can update matrices without touching geometry,
 * materials, or models. Anything else (size, color, visibility, model,
 * level, wall attach) is NOT matrix-only.
 */
export function isTransformOnlyFurnitureChange(a: Furniture, b: Furniture): boolean {
  if (
    a.x === b.x &&
    a.y === b.y &&
    a.elevation === b.elevation &&
    a.angleDeg === b.angleDeg
  ) {
    return false // nothing transform-related changed
  }
  return (
    a.width === b.width &&
    a.depth === b.depth &&
    a.height === b.height &&
    a.pitchDeg === b.pitchDeg &&
    a.rollDeg === b.rollDeg &&
    a.color === b.color &&
    a.catalogId === b.catalogId &&
    a.name === b.name &&
    a.visible === b.visible &&
    a.movable === b.movable &&
    a.levelRef === b.levelRef &&
    a.wallRef === b.wallRef &&
    a.doorOrWindow === b.doorOrWindow &&
    a.modelMirrored === b.modelMirrored &&
    a.modelPath === b.modelPath
  )
}

/**
 * Options the delta path needs to mirror buildScene's behaviour: custom model
 * URL resolution, the animation-loop kick after an async GLB swap-in, and the
 * active level filter (furniture on other levels must NOT be rendered).
 */
export interface ApplySceneUpdateOptions {
  modelUrlResolver?: ModelUrlResolver
  onModelReady?: () => void
  activeLevel?: string | null
  isOutsideView?: boolean
}

/** Apply one delta in place. False = caller must fall back to full rebuild. */
export function applySceneUpdate(
  scene: THREE.Scene,
  update: SceneUpdate,
  home: NormalizedHomeState,
  oldHome?: NormalizedHomeState | null,
  opts?: ApplySceneUpdateOptions,
): boolean {
  switch (update.type) {
    case 'furniture-update': {
      const old = oldHome?.furniture.find((f) => f.id === update.furnitureId)
      if (!old || !update.furniture || !isTransformOnlyFurnitureChange(old, update.furniture)) {
        return false
      }
      return applyFurnitureMatrixUpdate(scene, update, home)
    }
    case 'wall-update':
      return applyWallUpdate(scene, update, home, oldHome)
    case 'wall-delete':
      return applyWallDelete(scene, update, home, oldHome)
    case 'room-update':
      return applyRoomUpdate(scene, update, home, opts)
    case 'room-delete':
      return applyRoomDelete(scene, update)
    case 'furniture-delete':
      return applyFurnitureDelete(scene, update)
    case 'furniture-add':
      return applyFurnitureAdd(scene, update, home, opts)
    default:
      // 'level-change' and 'full-rebuild' always rebuild.
      return false
  }
}

function levelElevations(home: NormalizedHomeState): Map<string, number> {
  const elevations = new Map<string, number>()
  for (const level of home.levels) elevations.set(level.id, level.elevation)
  return elevations
}

function elevationAt(ref: string | null | undefined, elevations: Map<string, number>): number {
  return ref ? elevations.get(ref) ?? 0 : 0
}

/** Remove every object named `name`, dispose geometries, drop emptied groups. */
function removeNamed(scene: THREE.Scene, name: string): void {
  const dead: THREE.Object3D[] = []
  scene.traverse((o) => {
    if (o.name === name) dead.push(o)
  })
  for (const o of dead) {
    const parent = o.parent
    parent?.remove(o)
    // Opening walls live in an unnamed Group; drop it once empty.
    if (parent && !parent.name && parent.parent && parent.children.length === 0) {
      parent.parent.remove(parent)
    }
  }
  for (const o of dead) {
    o.traverse((child) => {
      ;(child as THREE.Mesh).geometry?.dispose()
    })
    // Materials are not disposed — the shared-texture convention applies.
  }
}

// Module-scratch objects: the matrix path must allocate nothing per frame.
const scratchMatrix = new THREE.Matrix4()
const scratchPos = new THREE.Vector3()
const scratchAxis = new THREE.Vector3(0, 1, 0)
const unitScale = new THREE.Vector3(1, 1, 1)
const scratchQuat = new THREE.Quaternion()

/**
 * furniture-update: matrix-only. Sets translation (x/y/elevation) and Y
 * rotation on the existing mesh — or rewrites a single instance matrix when
 * the piece lives in a T1 InstancedMesh group. No geometry/model work.
 */
function applyFurnitureMatrixUpdate(
  scene: THREE.Scene,
  update: SceneUpdate,
  home: NormalizedHomeState,
): boolean {
  const id = update.furnitureId
  const item = update.furniture
  if (!id || !item) return false
  const elevations = levelElevations(home)
  const elev = elevationAt(item.levelRef, elevations)

  const individual = scene.getObjectByName(`furniture:${id}`)
  if (individual) {
    individual.position.set(item.x, elev + (item.elevation ?? 0) + item.height / 2, item.y)
    individual.rotation.y = THREE.MathUtils.degToRad(item.angleDeg)
    return true
  }

  // Instanced group member: find the owning InstancedMesh via its id list.
  let owner: THREE.InstancedMesh | undefined
  let index = -1
  scene.traverse((o) => {
    if (owner || !(o instanceof THREE.InstancedMesh)) return
    const ids = o.userData.instanceFurnitureIds as string[] | undefined
    if (!ids) return
    const i = ids.indexOf(id)
    if (i >= 0) {
      owner = o
      index = i
    }
  })
  if (!owner) return false
  scratchQuat.setFromAxisAngle(scratchAxis, THREE.MathUtils.degToRad(item.angleDeg))
  scratchMatrix.compose(
    scratchPos.set(item.x, elev + (item.elevation ?? 0), item.y),
    scratchQuat,
    unitScale,
  )
  owner.setMatrixAt(index, scratchMatrix)
  owner.instanceMatrix.needsUpdate = true
  return true
}

/**
 * wall-update: rebuild only the edited wall's geometry (mesh + edge
 * highlight) plus any wall sharing an endpoint with it — the mitered joint
 * changes shape when a neighbor moves. Endpoints are checked against BOTH
 * the old and new positions of the edited wall: a neighbor joined at the
 * pre-move endpoint needs its miter recomputed even after the end moved
 * away. Furniture and rooms are untouched.
 */
function applyWallUpdate(
  scene: THREE.Scene,
  update: SceneUpdate,
  home: NormalizedHomeState,
  oldHome?: NormalizedHomeState | null,
): boolean {
  const wall = update.wall
  if (!wall || !update.wallId) return false
  const root = scene.getObjectByName('home')
  if (!root) return false

  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5
  const joins = (w: Wall, x: number, y: number): boolean =>
    (near(w.xStart, x) && near(w.yStart, y)) || (near(w.xEnd, x) && near(w.yEnd, y))
  const corners: Array<[number, number]> = [
    [wall.xStart, wall.yStart],
    [wall.xEnd, wall.yEnd],
  ]
  const oldWall = oldHome?.walls.find((w) => w.id === wall.id)
  if (oldWall) {
    corners.push([oldWall.xStart, oldWall.yStart], [oldWall.xEnd, oldWall.yEnd])
  }

  const touched = new Map<string, Wall>([[wall.id, wall]])
  for (const other of home.walls) {
    if (touched.has(other.id)) continue
    if (corners.some(([cx, cy]) => joins(other, cx, cy))) touched.set(other.id, other)
  }

  const elevations = levelElevations(home)
  const wallsTransparency = home.environment.wallsAlpha ?? 0
  for (const [, w] of touched) {
    remeshWall(scene, root, w, home, elevations, wallsTransparency)
  }
  return true
}

/**
 * Remove and rebuild one wall's mesh + edge highlight, mirroring buildScene.
 * Shared by wall-update (edited + miter-affected neighbors) and wall-delete
 * (neighbors whose miter changed when the deleted wall vanished).
 */
function remeshWall(
  scene: THREE.Scene,
  root: THREE.Object3D,
  w: Wall,
  home: NormalizedHomeState,
  elevations: Map<string, number>,
  wallsTransparency: number,
): void {
  removeNamed(scene, `wall:${w.id}`)
  removeNamed(scene, `wall-edge:${w.id}`)
  const elev = elevationAt(w.levelRef, elevations)
  const mesh = wallMesh(w, elev, wallsTransparency, home.furniture, home.walls)
  root.add(mesh)
  root.add(wallEdges(w, elev, home.walls))
  if (home.selection.includes(w.id)) tintEmissive(mesh)
}

/**
 * wall-delete: remove the deleted wall's mesh + edges, and re-mesh every wall
 * that shared an endpoint with it — wallOutlinePoints miters wall ends
 * against joined neighbors, so the neighbors' geometry changes when the
 * deleted wall disappears. Without oldHome we don't know the deleted wall's
 * endpoints, so we can't identify affected neighbors → conservative rebuild.
 */
function applyWallDelete(
  scene: THREE.Scene,
  update: SceneUpdate,
  home: NormalizedHomeState,
  oldHome?: NormalizedHomeState | null,
): boolean {
  const id = update.wallId
  if (!id) return false
  const deleted = oldHome?.walls.find((w) => w.id === id)
  if (!deleted) return false
  const root = scene.getObjectByName('home')
  if (!root) return false

  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5
  const joins = (w: Wall, x: number, y: number): boolean =>
    (near(w.xStart, x) && near(w.yStart, y)) || (near(w.xEnd, x) && near(w.yEnd, y))
  const corners: Array<[number, number]> = [
    [deleted.xStart, deleted.yStart],
    [deleted.xEnd, deleted.yEnd],
  ]

  // The deleted wall is already absent from home.walls; only neighbors remain.
  const touched = home.walls.filter((w) => corners.some(([cx, cy]) => joins(w, cx, cy)))

  removeNamed(scene, `wall:${id}`)
  removeNamed(scene, `wall-edge:${id}`)
  const elevations = levelElevations(home)
  const wallsTransparency = home.environment.wallsAlpha ?? 0
  for (const w of touched) {
    remeshWall(scene, root, w, home, elevations, wallsTransparency)
  }
  return true
}

/**
 * room-update: rebuild only the edited room's floor/ceiling geometry.
 * Furniture and walls are untouched.
 */
function applyRoomUpdate(
  scene: THREE.Scene,
  update: SceneUpdate,
  home: NormalizedHomeState,
  opts?: ApplySceneUpdateOptions,
): boolean {
  const room = update.room
  if (!room || !update.roomId) return false
  const root = scene.getObjectByName('home')
  if (!root) return false

  removeNamed(scene, `room:${room.id}`)
  removeNamed(scene, `ceiling:${room.id}`)

  const activeLevel = opts?.activeLevel ?? null
  const isOutsideView = opts?.isOutsideView ?? false
  const isActive = matchesLevel(room.levelRef, activeLevel)
  const belowLevelId = findLevelBelowId(activeLevel, home.levels)
  const isBelowActive = belowLevelId !== undefined && (room.levelRef ?? null) === belowLevelId

  const elev = elevationAt(room.levelRef, levelElevations(home))
  let floor: THREE.Mesh | null = null
  let ceiling: THREE.Mesh | null = null
  if (room.points.length >= 3 && (isActive || isBelowActive)) {
    if (isActive && room.floorVisible !== false) {
      floor = roomMesh(room, elev)
      root.add(floor)
    } else if (isBelowActive) {
      floor = roomMesh(room, elev, { opacity: BELOW_LEVEL_FLOOR_OPACITY })
      root.add(floor)
    }
    if (shouldShowCeiling(room, { isOutsideView, isBelowActiveLevel: isBelowActive })) {
      ceiling = ceilingMesh(room, elev, home.levels)
      root.add(ceiling)
    }
  }
  if (home.selection.includes(room.id)) {
    if (floor) tintEmissive(floor)
    if (ceiling) tintEmissive(ceiling)
  }
  return true
}

/**
 * room-delete: remove the deleted room's floor + ceiling meshes. Rooms have
 * no cross-object geometry dependencies (unlike walls' miters), so removal
 * alone mirrors what buildScene would render. Nothing is added, so the
 * 'home' root is not required.
 */
function applyRoomDelete(scene: THREE.Scene, update: SceneUpdate): boolean {
  const id = update.roomId
  if (!id) return false
  removeNamed(scene, `room:${id}`)
  removeNamed(scene, `ceiling:${id}`)
  return true
}

/**
 * furniture-delete: remove the standalone mesh when one exists. If the id
 * has no standalone mesh it is either an InstancedMesh group member (shrinking
 * instance buffers is NOT supported here) or was invisible/off-level and never
 * rendered — both fall back to rebuild.
 */
function applyFurnitureDelete(scene: THREE.Scene, update: SceneUpdate): boolean {
  const id = update.furnitureId
  if (!id) return false
  if (!scene.getObjectByName(`furniture:${id}`)) return false
  removeNamed(scene, `furniture:${id}`)
  return true
}

/**
 * furniture-add: build the new item with the same single-item builder
 * buildScene uses (furnitureMesh). Cases that buildScene would NOT render are
 * handled as consistent no-ops (true, nothing added): invisible items and
 * items on another level when a level filter is active. Door/window openings
 * are baked into the referenced wall's geometry, so those adds fall back to
 * rebuild (conservative — see wallMesh's furniture-driven opening cutouts).
 */
function applyFurnitureAdd(
  scene: THREE.Scene,
  update: SceneUpdate,
  home: NormalizedHomeState,
  opts?: ApplySceneUpdateOptions,
): boolean {
  const id = update.furnitureId
  const item = update.furniture
  if (!id || !item) return false
  const root = scene.getObjectByName('home')
  if (!root) return false

  // Mirror scene.ts matchesLevel: null activeLevel renders everything.
  const activeLevel = opts?.activeLevel ?? null
  if (item.visible === false) return true
  if (activeLevel !== null && (item.levelRef ?? null) !== activeLevel) return true
  if (item.doorOrWindow) {
    // Opening cutouts live in the wall mesh, not a standalone furniture mesh.
    return false
  }

  // The scene predates this item, so it cannot already sit in an InstancedMesh
  // group; if it matches a grouped catalog shape it renders as a standalone
  // mesh until the next rebuild regroups — visually identical either way.
  const elev = elevationAt(item.levelRef, levelElevations(home))
  const mesh = withModelUrlResolver(opts?.modelUrlResolver, () =>
    furnitureMesh(item, elev, opts?.onModelReady, home.selection.includes(item.id)),
  )
  root.add(mesh)
  return true
}

// ── Delta metrics tracking (A2) ─────────────────────────────────────────────
//
// Accumulates delta vs full-rebuild counts and durations for the current 60s
// telemetry window. view.ts samples snapshotDeltaMetrics() every 60s and
// reports via telemetry.sceneDeltaMetrics(); sampling resets the window.

export interface SceneDeltaWindowSnapshot {
  deltaUpdatesCount: number
  fullRebuildsCount: number
  avgDeltaDurationMs: number
  avgRebuildDurationMs: number
  deltaRatio: number // 0-1, share of applied deltas vs total scene updates
  windowDurationMs: number
  deltaCountByType: Record<string, number> // delta counts per operation type
}

const METRICS_WINDOW_MS = 60_000
const deltaWindow = {
  deltaCount: 0,
  deltaMs: 0,
  rebuildCount: 0,
  rebuildMs: 0,
  byType: new Map<string, { count: number; ms: number }>(),
}

/** Record one applied delta operation (any type the delta path handled). */
export function recordSceneDelta(type: SceneUpdateType, durationMs: number): void {
  deltaWindow.deltaCount++
  deltaWindow.deltaMs += durationMs
  const t = deltaWindow.byType.get(type) ?? { count: 0, ms: 0 }
  t.count++
  t.ms += durationMs
  deltaWindow.byType.set(type, t)
}

/** Record one full-scene rebuild (delta-path fallback or manual rebuild). */
export function recordFullRebuild(durationMs: number): void {
  deltaWindow.rebuildCount++
  deltaWindow.rebuildMs += durationMs
}

/** Return the current window's metrics and reset all accumulators. */
export function snapshotDeltaMetrics(): SceneDeltaWindowSnapshot {
  const { deltaCount, deltaMs, rebuildCount, rebuildMs, byType } = deltaWindow
  deltaWindow.deltaCount = 0
  deltaWindow.deltaMs = 0
  deltaWindow.rebuildCount = 0
  deltaWindow.rebuildMs = 0
  deltaWindow.byType = new Map()
  const deltaCountByType: Record<string, number> = {}
  for (const [type, t] of byType) deltaCountByType[type] = t.count
  const total = deltaCount + rebuildCount
  return {
    deltaUpdatesCount: deltaCount,
    fullRebuildsCount: rebuildCount,
    avgDeltaDurationMs: deltaCount > 0 ? deltaMs / deltaCount : 0,
    avgRebuildDurationMs: rebuildCount > 0 ? rebuildMs / rebuildCount : 0,
    deltaRatio: total > 0 ? deltaCount / total : 0,
    windowDurationMs: METRICS_WINDOW_MS,
    deltaCountByType,
  }
}
