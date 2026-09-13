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
