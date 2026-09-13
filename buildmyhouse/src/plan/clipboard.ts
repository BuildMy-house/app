import type { HomeStore } from '../core/store'
import { HomeModel, NEW_WALL_PATTERN_ID } from '../core/model'
import type { Wall, Room, Furniture, DimensionLine, Label, Level } from '../core/home'
import { DEFAULT_WALL_HEIGHT_CM } from '../core/home'

export type CollectionName = 'levels' | 'walls' | 'rooms' | 'furniture' | 'dimensionLines' | 'labels'
interface ClipboardEntry {
  collection: CollectionName
  item: Record<string, unknown>
}

export const PASTE_OFFSET_CM = 20

export class ClipboardManager {
  private readonly store: HomeStore
  private readonly model: HomeModel
  private clipboard: ClipboardEntry[] = []

  constructor(store: HomeStore, model: HomeModel) {
    this.store = store
    this.model = model
  }

  copy(): number {
    const home = this.store.getHome()
    const selected = new Set(home.selection)
    const clip: ClipboardEntry[] = []
    const collections: CollectionName[] = ['levels', 'walls', 'rooms', 'furniture', 'dimensionLines', 'labels']
    for (const collection of collections) {
      for (const item of home[collection]) {
        if (selected.has(item.id)) {
          clip.push({ collection, item: structuredClone(item) as unknown as Record<string, unknown> })
        }
      }
    }
    this.clipboard = clip
    return clip.length
  }

  paste(): string[] {
    if (this.clipboard.length === 0) return []
    const ids = this.clipboard.map((entry) => this.pasteItem(entry, PASTE_OFFSET_CM, PASTE_OFFSET_CM))
    this.model.setSelection(ids)
    return ids
  }

  duplicate(): string[] {
    const clip: ClipboardEntry[] = []
    const home = this.store.getHome()
    const selected = new Set(home.selection)
    const collections: CollectionName[] = ['levels', 'walls', 'rooms', 'furniture', 'dimensionLines', 'labels']
    for (const collection of collections) {
      for (const item of home[collection]) {
        if (selected.has(item.id)) {
          clip.push({ collection, item: structuredClone(item) as unknown as Record<string, unknown> })
        }
      }
    }
    if (clip.length === 0) return []
    const ids = clip.map((entry) => this.pasteItem(entry, PASTE_OFFSET_CM, PASTE_OFFSET_CM))
    this.model.setSelection(ids)
    return ids
  }

  getClipboardLength(): number {
    return this.clipboard.length
  }

  private pasteItem(entry: ClipboardEntry, dx: number, dy: number): string {
    const item = entry.item
    switch (entry.collection) {
      case 'walls': {
        const w = item as unknown as Wall
        const created = this.model.addWall({
          xStart: w.xStart + dx,
          yStart: w.yStart + dy,
          xEnd: w.xEnd + dx,
          yEnd: w.yEnd + dy,
          thickness: w.thickness,
          height: w.height ?? DEFAULT_WALL_HEIGHT_CM,
          patternId: w.patternId ?? NEW_WALL_PATTERN_ID,
        })
        return created.id
      }
      case 'rooms': {
        const r = item as unknown as Room
        const points = r.points.map(([x, y]) => [x + dx, y + dy] as [number, number])
        const { id: _id, points: _points, ...rest } = r
        const created = this.model.addRoom(points, rest as Partial<Omit<Room, 'id' | 'points'>>)
        return created.id
      }
      case 'furniture': {
        const f = item as unknown as Furniture
        const { id: _fId, ...frest } = f
        const created = this.model.addFurniture({ ...(frest as Omit<Furniture, 'id'>), x: f.x + dx, y: f.y + dy })
        return created.id
      }
      case 'dimensionLines': {
        const d = item as unknown as DimensionLine
        const created = this.model.addDimensionLine({
          xStart: d.xStart + dx,
          yStart: d.yStart + dy,
          xEnd: d.xEnd + dx,
          yEnd: d.yEnd + dy,
          offset: d.offset,
          elevationStart: d.elevationStart,
          elevationEnd: d.elevationEnd,
          levelRef: d.levelRef ?? null,
        })
        return created.id
      }
      case 'labels': {
        const l = item as unknown as Label
        const { id: _lId, ...lrest } = l
        const created = this.model.addLabel({ ...(lrest as Omit<Label, 'id'>), x: l.x + dx, y: l.y + dy })
        return created.id
      }
      case 'levels': {
        const lv = item as unknown as Level
        const { id: _lvId, ...lvrest } = lv
        const created = this.model.addLevel(lvrest as Omit<Level, 'id'>)
        return created.id
      }
    }
  }
}
