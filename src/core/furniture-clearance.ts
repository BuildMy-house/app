import { resolveFootprint, type Resolution } from '../plan/furniture-room-fit'
import { footprintAt, overlapsAnySolid, wallSolids, type WallSolids } from '../plan/wall-solids'
import { wallsBlockingAt } from '../plan/wall-height'
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
 * meant to sit IN walls and are exempt. A piece hung above a wall's top is not
 * obstructed by that wall (see plan/wall-height.ts for the elevation rule).
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
  return [wall.xStart, wall.yStart, wall.xEnd, wall.yEnd, wall.thickness, wall.arcExtent ?? 0, wall.height ?? '', wall.heightAtEnd ?? '', wall.levelRef ?? ''].join('|')
}

function footprintKey(item: Furniture): string {
  return [item.x, item.y, item.angleDeg, item.width, item.depth, item.elevation, item.levelRef ?? ''].join('|')
}

function wallsChanged(draft: NormalizedHomeState, previous: NormalizedHomeState): boolean {
  if (draft.walls.length !== previous.walls.length) return true
  const before = new Map(previous.walls.map((wall) => [wall.id, wallKey(wall)]))
  return draft.walls.some((wall) => before.get(wall.id) !== wallKey(wall))
}

interface Level {
  walls: Wall[]
  rooms: Room[]
  /** Solids per set of blocking walls, keyed by how many walls block (the set
   *  is fully determined by the count, since wall tops are totally ordered). */
  solidsByBlocking: Map<number, WallSolids>
}

function levelOf(state: NormalizedHomeState, levelRef: string | null): Level {
  return {
    walls: state.walls.filter((wall) => (wall.levelRef ?? null) === levelRef),
    rooms: state.rooms.filter((room) => (room.levelRef ?? null) === levelRef && room.points.length >= 3),
    solidsByBlocking: new Map(),
  }
}

/** The level's wall solids as seen by a piece at this elevation. */
function solidsAt(level: Level, elevationCm: number): WallSolids {
  const blocking = wallsBlockingAt(level.walls, elevationCm)
  let solids = level.solidsByBlocking.get(blocking.length)
  if (!solids) {
    solids = wallSolids(blocking)
    level.solidsByBlocking.set(blocking.length, solids)
  }
  return solids
}

function resolveItemResult(item: Furniture, level: Level): Resolution {
  return resolveFootprint(solidsAt(level, item.elevation), level.rooms, { x: item.x, y: item.y }, item.width, item.depth, item.angleDeg)
}

function tooLarge(item: Furniture, result: Extract<Resolution, { fits: false }>): FurnitureTooLargeError {
  return new FurnitureTooLargeError(
    item.id, item.name, item.width, item.depth, item.angleDeg,
    result.room.id, result.room.name ?? null, result.roomWidthCm, result.roomDepthCm,
  )
}

/** Where the piece ends up: unchanged when clear, otherwise the nearest flush
 *  position. Throws FurnitureTooLargeError when it is in a room it cannot fit. */
function resolveItem(item: Furniture, level: Level): { x: number; y: number } {
  const result = resolveItemResult(item, level)
  if (result.fits) return result
  throw tooLarge(item, result)
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
    const solids = solidsAt(level, item.elevation)
    if (solids.rects.length === 0 && solids.arcs.length === 0) continue
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
    moveTo(item, clear, draft.walls)
  }
}

/** Moves a piece, keeping the along-wall offset of a wall-attached piece in step. */
function moveTo(item: Furniture, to: { x: number; y: number }, walls: ReadonlyArray<Wall>): void {
  item.x = to.x
  item.y = to.y
  const attached = item.wallRef ? walls.find((wall) => wall.id === item.wallRef) : undefined
  if (attached) {
    const dx = attached.xEnd - attached.xStart
    const dy = attached.yEnd - attached.yStart
    const length = Math.hypot(dx, dy)
    if (length > 0) item.wallOffset = ((item.x - attached.xStart) * dx + (item.y - attached.yStart) * dy) / length
  }
}

export interface ClearanceViolations {
  /** One entry per wall a piece penetrates. */
  overlaps: Array<{ furnitureId: string; wallId: string }>
  /** One entry per piece that cannot fit anywhere inside the room it is in. */
  oversize: Array<{ furnitureId: string; roomId: string; message: string }>
}

function overlappingWalls(item: Furniture, blocking: ReadonlyArray<Wall>): string[] {
  const footprint = footprintAt(item.x, item.y, item.width, item.depth, item.angleDeg)
  return blocking.filter((wall) => overlapsAnySolid(footprint, wallSolids([wall]))).map((wall) => wall.id)
}

/**
 * Every clearance violation currently in `state`, whether or not the file was
 * loaded that way. The store never produces one through an edit, but loadHome,
 * saved files, templates and undo/redo restore states verbatim, so this is how
 * a legacy overlap is found (and what the MCP validator mirrors, see
 * mcp/furniture_clearance.py).
 */
export function findClearanceViolations(state: Pick<NormalizedHomeState, 'walls' | 'rooms' | 'furniture'>): ClearanceViolations {
  const result: ClearanceViolations = { overlaps: [], oversize: [] }
  const levels = new Map<string | null, Level>()
  for (const item of state.furniture) {
    if (item.doorOrWindow) continue
    const ref = item.levelRef ?? null
    let level = levels.get(ref)
    if (!level) {
      level = levelOf(state as NormalizedHomeState, ref)
      levels.set(ref, level)
    }
    const blocking = wallsBlockingAt(level.walls, item.elevation)
    if (blocking.length === 0) continue
    for (const wallId of overlappingWalls(item, blocking)) result.overlaps.push({ furnitureId: item.id, wallId })
    const fit = resolveItemResult(item, level)
    if (!fit.fits) result.oversize.push({ furnitureId: item.id, roomId: fit.room.id, message: tooLarge(item, fit).message })
  }
  return result
}

export interface ClearanceFix {
  /** Pieces to move flush against the walls they penetrate. */
  moves: Array<{ furnitureId: string; furnitureName: string; x: number; y: number }>
  /** Pieces that cannot be fixed: too large for their room, so no position clears the walls. */
  unfixable: Array<{ furnitureId: string; furnitureName: string; message: string }>
}

/**
 * What it takes to make a loaded home obey the clearance rule, without touching
 * it: each piece that overlaps a wall is moved to the position the store would
 * have given it, and a piece too large for its room is reported (never moved or
 * thrown at; the user has to resize or remove it).
 */
export function planClearanceFix(state: Pick<NormalizedHomeState, 'walls' | 'rooms' | 'furniture'>): ClearanceFix {
  const fix: ClearanceFix = { moves: [], unfixable: [] }
  const found = findClearanceViolations(state)
  const flagged = new Set([...found.overlaps.map((o) => o.furnitureId), ...found.oversize.map((o) => o.furnitureId)])
  const levels = new Map<string | null, Level>()
  for (const item of state.furniture) {
    if (!flagged.has(item.id)) continue
    const ref = item.levelRef ?? null
    let level = levels.get(ref)
    if (!level) {
      level = levelOf(state as NormalizedHomeState, ref)
      levels.set(ref, level)
    }
    const fit = resolveItemResult(item, level)
    if (!fit.fits) fix.unfixable.push({ furnitureId: item.id, furnitureName: item.name, message: tooLarge(item, fit).message })
    else if (fit.x !== item.x || fit.y !== item.y) fix.moves.push({ furnitureId: item.id, furnitureName: item.name, x: fit.x, y: fit.y })
  }
  return fix
}

/** Applies the moves of a ClearanceFix to a draft (ids that no longer exist are skipped). */
export function applyClearanceMoves(draft: NormalizedHomeState, moves: ClearanceFix['moves']): void {
  for (const move of moves) {
    const item = draft.furniture.find((f) => f.id === move.furnitureId)
    if (item) moveTo(item, move, draft.walls)
  }
}
