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
import { ceilingMesh, roomMesh, tintEmissive, wallEdges, wallMesh } from './scene'

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

/**
 * Scene object IDs used for tracking Three.js objects.
 * Maps domain IDs to scene node IDs for update operations.
 */
export interface SceneNodeMap {
  walls: Map<string, THREE.Object3D>
  furniture: Map<string, THREE.Object3D>
  rooms: Map<string, THREE.Object3D>
}

/**
 * Get or create the scene node map from userData.
 */
export function getSceneNodeMap(scene: THREE.Scene): SceneNodeMap {
  const map: SceneNodeMap = (scene.userData.nodeMap ??= {
    walls: new Map(),
    furniture: new Map(),
    rooms: new Map(),
  })
  return map
}

/**
 * Register a Three.js object as representing a domain entity.
 */
export function registerSceneNode(
  nodeMap: SceneNodeMap,
  type: 'wall' | 'furniture' | 'room',
  id: string,
  object: THREE.Object3D,
): void {
  nodeMap[type === 'wall' ? 'walls' : type === 'furniture' ? 'furniture' : 'rooms'].set(id, object)
}

/**
 * Unregister a Three.js object and remove it from the scene.
 */
export function unregisterSceneNode(
  scene: THREE.Scene,
  nodeMap: SceneNodeMap,
  type: 'wall' | 'furniture' | 'room',
  id: string,
): void {
  const map = nodeMap[type === 'wall' ? 'walls' : type === 'furniture' ? 'furniture' : 'rooms']
  const object = map.get(id)
  if (object) {
    scene.remove(object)
    map.delete(id)
    // Clean up geometry/materials if they won't be reused
    object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry?.dispose()
        // Don't dispose material — it may be shared
      }
    })
  }
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

/** Apply one delta in place. False = caller must fall back to full rebuild. */
export function applySceneUpdate(
  scene: THREE.Scene,
  update: SceneUpdate,
  home: NormalizedHomeState,
  oldHome?: NormalizedHomeState | null,
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
    case 'room-update':
      return applyRoomUpdate(scene, update, home)
    default:
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
  for (const [wid, w] of touched) {
    removeNamed(scene, `wall:${wid}`)
    removeNamed(scene, `wall-edge:${wid}`)
    const elev = elevationAt(w.levelRef, elevations)
    const mesh = wallMesh(w, elev, wallsTransparency, home.furniture, home.walls)
    root.add(mesh)
    root.add(wallEdges(w, elev, home.walls))
    if (home.selection.includes(wid)) tintEmissive(mesh)
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
): boolean {
  const room = update.room
  if (!room || !update.roomId) return false
  const root = scene.getObjectByName('home')
  if (!root) return false

  removeNamed(scene, `room:${room.id}`)
  removeNamed(scene, `ceiling:${room.id}`)

  const elev = elevationAt(room.levelRef, levelElevations(home))
  let floor: THREE.Mesh | null = null
  let ceiling: THREE.Mesh | null = null
  if (room.points.length >= 3) {
    if (room.floorVisible !== false) {
      floor = roomMesh(room, elev)
      root.add(floor)
    }
    ceiling = ceilingMesh(room, elev, home.levels)
    if (ceiling) root.add(ceiling)
  }
  if (home.selection.includes(room.id)) {
    if (floor) tintEmissive(floor)
    if (ceiling) tintEmissive(ceiling)
  }
  return true
}
