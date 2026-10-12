import { separateFurnitureFromWalls } from '../plan/furniture-snap'
import type { Furniture, NormalizedHomeState, Wall } from './home'

/**
 * Store-level invariant: furniture never overlaps a wall on its own level.
 *
 * HomeStore.apply runs this on every mutation, so every path (2D/3D drag,
 * catalog placement, rotate, gizmo, properties panel, nudge, paste/duplicate,
 * MCP add/modify, wall edits) goes through the same shared
 * separateFurnitureFromWalls logic instead of each UI path remembering to.
 *
 * Only pieces whose footprint changed (or every piece, when a wall changed)
 * are re-checked, so an unrelated edit never moves furniture in a loaded file
 * that already overlaps. Doors and windows (`doorOrWindow`) are meant to sit
 * IN walls and are exempt.
 */

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

export function enforceFurnitureClearance(draft: NormalizedHomeState, previous: NormalizedHomeState): void {
  if (draft.walls.length === 0 || draft.furniture.length === 0) return
  const allChanged = wallsChanged(draft, previous)
  const before = new Map(previous.furniture.map((item) => [item.id, footprintKey(item)]))
  for (const item of draft.furniture) {
    if (item.doorOrWindow) continue
    if (!allChanged && before.get(item.id) === footprintKey(item)) continue
    const level = item.levelRef ?? null
    const walls = draft.walls.filter((wall) => (wall.levelRef ?? null) === level)
    if (walls.length === 0) continue
    const clear = separateFurnitureFromWalls({ x: item.x, y: item.y }, walls, item.width, item.depth, item.angleDeg)
    if (clear.x === item.x && clear.y === item.y) continue
    item.x = clear.x
    item.y = clear.y
    const attached = item.wallRef ? walls.find((wall) => wall.id === item.wallRef) : undefined
    if (attached) {
      const dx = attached.xEnd - attached.xStart
      const dy = attached.yEnd - attached.yStart
      const length = Math.hypot(dx, dy)
      if (length > 0) item.wallOffset = ((item.x - attached.xStart) * dx + (item.y - attached.yStart) * dy) / length
    }
  }
}
