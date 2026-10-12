import { resolveFootprint } from '../plan/furniture-room-fit'
import { wallSolids, type WallSolids } from '../plan/wall-solids'
import type { Furniture, NormalizedHomeState, Room, Wall } from './home'

/**
 * Store-level invariant: furniture never overlaps a wall on its own level, and
 * furniture inside a room is never moved out of it.
 *
 * HomeStore.apply runs this on every mutation, so every path (2D/3D drag,
 * catalog placement, rotate, gizmo, properties panel, nudge, paste/duplicate,
 * MCP add/modify, wall edits) goes through the same shared logic instead of
 * each UI path remembering to.
 *
 * A piece that overlaps a wall is pushed to the nearest flush position. If it
 * is inside a room (its centre is in the room polygon) and cannot fit anywhere
 * inside that room's walls — bigger than the room — the mutation is REJECTED
 * with a FurnitureTooLargeError instead of being relocated, and because apply
 * runs this before committing, nothing changes (no state, no undo entry). A
 * wall edit that would shrink a room below a piece it holds is rejected the
 * same way. A piece outside every room keeps the plain push-out behaviour.
 *
 * Only pieces whose footprint changed (or every piece, when a wall changed)
 * are re-checked, so an unrelated edit never moves furniture in a loaded file
 * that already overlaps or is oversize. Doors and windows (`doorOrWindow`) are
 * meant to sit IN walls and are exempt.
 */

export class FurnitureTooLargeError extends Error {
  constructor(
    readonly furnitureId: string,
    readonly furnitureName: string,
    readonly widthCm: number,
    readonly depthCm: number,
    readonly angleDeg: number,
    readonly roomId: string,
    readonly roomName: string | null,
    readonly roomWidthCm: number,
    readonly roomDepthCm: number,
  ) {
    super(
      `"${furnitureName}" (${fmt(widthCm)} x ${fmt(depthCm)} cm) is too large for ${roomName ? `room "${roomName}"` : `room ${roomId}`} `
      + `(about ${fmt(roomWidthCm)} x ${fmt(roomDepthCm)} cm): it cannot fit inside the room's walls.`,
    )
    this.name = 'FurnitureTooLargeError'
  }
}

function fmt(cm: number): string {
  return String(Math.round(cm * 10) / 10)
}

function wallKey(wall: Wall): string {
  return [wall.xStart, wall.yStart, wall.xEnd, wall.yEnd, wall.thickness, wall.arcExtent ?? 0, wall.levelRef ?? ''].join('|')
}

function footprintKey(item: Furniture): string {
  return [item.x, item.y, item.angleDeg, item.width, item.depth, item.levelRef ?? ''].join('|')
}

function wallsChanged(draft: NormalizedHomeState, previous: NormalizedHomeState): boolean {
  if (draft.walls.length !== previous.walls.length) return true
  const before = new Map(previous.walls.map((wall) => [wall.id, wallKey(wall)]))
  return draft.walls.some((wall) => before.get(wall.id) !== wallKey(wall))
}

interface Level {
  solids: WallSolids
  rooms: Room[]
}

function levelOf(state: NormalizedHomeState, levelRef: string | null): Level {
  return {
    solids: wallSolids(state.walls.filter((wall) => (wall.levelRef ?? null) === levelRef)),
    rooms: state.rooms.filter((room) => (room.levelRef ?? null) === levelRef && room.points.length >= 3),
  }
}

/** Where the piece ends up: unchanged when clear, otherwise the nearest flush
 *  position. Throws FurnitureTooLargeError when it is in a room it cannot fit. */
function resolveItem(item: Furniture, level: Level): { x: number; y: number } {
  const result = resolveFootprint(level.solids, level.rooms, { x: item.x, y: item.y }, item.width, item.depth, item.angleDeg)
  if (result.fits) return result
  throw new FurnitureTooLargeError(
    item.id, item.name, item.width, item.depth, item.angleDeg,
    result.room.id, result.room.name ?? null, result.roomWidthCm, result.roomDepthCm,
  )
}

export function enforceFurnitureClearance(draft: NormalizedHomeState, previous: NormalizedHomeState): void {
  if (draft.walls.length === 0 || draft.furniture.length === 0) return
  const allChanged = wallsChanged(draft, previous)
  const before = new Map(previous.furniture.map((item) => [item.id, footprintKey(item)]))
  const draftLevels = new Map<string | null, Level>()
  const previousLevels = new Map<string | null, Level>()
  const levelFor = (cache: Map<string | null, Level>, state: NormalizedHomeState, ref: string | null): Level => {
    let level = cache.get(ref)
    if (!level) {
      level = levelOf(state, ref)
      cache.set(ref, level)
    }
    return level
  }
  for (const item of draft.furniture) {
    if (item.doorOrWindow) continue
    const footprintChanged = before.get(item.id) !== footprintKey(item)
    if (!allChanged && !footprintChanged) continue
    const ref = item.levelRef ?? null
    const level = levelFor(draftLevels, draft, ref)
    if (level.solids.rects.length === 0 && level.solids.arcs.length === 0) continue
    let clear: { x: number; y: number }
    try {
      clear = resolveItem(item, level)
    } catch (err) {
      if (!(err instanceof FurnitureTooLargeError)) throw err
      // A wall edit only rejects for a piece that fitted before it; one that
      // was already oversize in a loaded file stays exactly as it was.
      const old = footprintChanged ? undefined : previous.furniture.find((f) => f.id === item.id)
      if (old) {
        try {
          resolveItem(old, levelFor(previousLevels, previous, ref))
        } catch (oldErr) {
          if (oldErr instanceof FurnitureTooLargeError) continue
          throw oldErr
        }
      }
      throw err
    }
    if (clear.x === item.x && clear.y === item.y) continue
    item.x = clear.x
    item.y = clear.y
    const attached = item.wallRef ? draft.walls.find((wall) => wall.id === item.wallRef) : undefined
    if (attached) {
      const dx = attached.xEnd - attached.xStart
      const dy = attached.yEnd - attached.yStart
      const length = Math.hypot(dx, dy)
      if (length > 0) item.wallOffset = ((item.x - attached.xStart) * dx + (item.y - attached.yStart) * dy) / length
    }
  }
}
