import type { FurnitureCatalog } from '../core/catalog'
import { HomeModel } from '../core/model'
import { HomeStore } from '../core/store'
import type { NormalizedHomeState } from '../core/home'
import { openingOnWall } from '../core/wall-opening'
import type { TemplatePlan } from './types'

/**
 * Build a fresh home from a template plan. Catalog ids supply 3D models and
 * colors when the catalog has them; a piece whose id is unknown (or when no
 * catalog is loaded) still lands as a plain box of the template's own size,
 * so a catalog change can never make a template fail to open.
 */
export function buildHomeFromTemplate(plan: TemplatePlan, catalog: FurnitureCatalog | null): NormalizedHomeState {
  const store = new HomeStore()
  const model = new HomeModel(store)
  model.setName(plan.name)

  const modelFor = (catalogId: string | undefined) => (catalogId ? catalog?.get(catalogId) ?? null : null)

  const wallIds = new Map<string, string>()
  const wallById = new Map<string, TemplatePlan['walls'][number]>()
  for (const wall of plan.walls) {
    const created = model.addWall({
      xStart: wall.xStart,
      yStart: wall.yStart,
      xEnd: wall.xEnd,
      yEnd: wall.yEnd,
      thickness: wall.thickness,
      height: wall.height,
    })
    wallIds.set(wall.key, created.id)
    wallById.set(wall.key, wall)
  }

  for (const room of plan.rooms) {
    model.addRoom(room.points, { name: room.name, floorTextureId: room.floorTextureId })
  }

  for (const opening of plan.openings) {
    const wall = wallById.get(opening.wallKey)
    const wallId = wallIds.get(opening.wallKey)
    if (!wall || !wallId) throw new Error(`template ${plan.id}: unknown wall ${opening.wallKey}`)
    const placed = openingOnWall(wall, opening.offset, 0)
    const resolved = modelFor(opening.catalogId)
    model.addFurniture({
      name: opening.name,
      catalogId: resolved?.catalogId ?? null,
      x: placed.x,
      y: placed.y,
      angleDeg: placed.angleDeg,
      width: opening.width,
      depth: opening.depth,
      height: opening.height,
      elevation: opening.elevation,
      color: resolved?.color ?? null,
      doorOrWindow: true,
      modelPath: resolved?.modelPath ?? null,
      renderModelPath: resolved?.renderModelPath ?? null,
      wallRef: wallId,
      wallOffset: placed.offset,
    })
  }

  for (const item of plan.furniture) {
    const resolved = modelFor(item.catalogId)
    model.addFurniture({
      name: item.name,
      catalogId: resolved?.catalogId ?? null,
      x: item.x,
      y: item.y,
      angleDeg: item.angleDeg,
      width: item.width,
      depth: item.depth,
      height: item.height,
      elevation: item.elevation,
      color: item.color ?? resolved?.color ?? null,
      doorOrWindow: false,
      modelPath: resolved?.modelPath ?? null,
      renderModelPath: resolved?.renderModelPath ?? null,
    })
  }

  return store.getHome()
}
