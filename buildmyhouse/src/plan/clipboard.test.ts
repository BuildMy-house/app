import { describe, expect, it } from 'vitest'
import { HomeStore } from '../core/store'
import { HomeModel } from '../core/model'
import { ClipboardManager, PASTE_OFFSET_CM } from './clipboard'

describe('ClipboardManager', () => {
  function setup() {
    const store = new HomeStore()
    const model = new HomeModel(store)
    const clipboard = new ClipboardManager(store, model)
    return { model, clipboard, store }
  }

  describe('copy', () => {
    it('returns 0 when nothing selected', () => {
      const { clipboard } = setup()
      expect(clipboard.copy()).toBe(0)
    })

    it('copies selected items to internal clipboard', () => {
      const { model, clipboard } = setup()
      const wall = model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 10 })
      model.setSelection([wall.id])
      expect(clipboard.copy()).toBe(1)
      expect(clipboard.getClipboardLength()).toBe(1)
    })
  })

  describe('paste', () => {
    it('returns empty array when clipboard is empty', () => {
      const { clipboard } = setup()
      expect(clipboard.paste()).toEqual([])
    })

    it('creates new items with different ids and offset properties', () => {
      const { store, model, clipboard } = setup()
      const wall = model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 10 })
      model.setSelection([wall.id])
      clipboard.copy()

      const pastedIds = clipboard.paste()
      expect(pastedIds).toHaveLength(1)
      expect(pastedIds[0]).not.toBe(wall.id)

      const home = store.getHome()
      expect(home.walls).toHaveLength(2)
      const original = home.walls.find((w) => w.id === wall.id)!
      const pasted = home.walls.find((w) => w.id === pastedIds[0])!
      expect(pasted.xStart).toBe(original.xStart + PASTE_OFFSET_CM)
      expect(pasted.yStart).toBe(original.yStart + PASTE_OFFSET_CM)
      expect(pasted.xEnd).toBe(original.xEnd + PASTE_OFFSET_CM)
      expect(pasted.yEnd).toBe(original.yEnd + PASTE_OFFSET_CM)
      expect(pasted.thickness).toBe(original.thickness)
    })

    it('pastes multiple items preserving relative offsets', () => {
      const { store, model, clipboard } = setup()
      const w1 = model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 10 })
      const w2 = model.addWall({ xStart: 200, yStart: 0, xEnd: 300, yEnd: 0, thickness: 7 })
      model.setSelection([w1.id, w2.id])
      clipboard.copy()

      const pastedIds = clipboard.paste()
      expect(pastedIds).toHaveLength(2)

      const home = store.getHome()
      expect(home.walls).toHaveLength(4)
    })

    it('sets selection to pasted items', () => {
      const { store, model, clipboard } = setup()
      const wall = model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 10 })
      model.setSelection([wall.id])
      clipboard.copy()
      const pastedIds = clipboard.paste()

      expect(store.getHome().selection).toEqual(pastedIds)
    })
  })

  describe('duplicate', () => {
    it('returns empty array when nothing selected', () => {
      const { clipboard } = setup()
      expect(clipboard.duplicate()).toEqual([])
    })

    it('creates new items without affecting internal clipboard', () => {
      const { store, model, clipboard } = setup()
      const wall = model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 10 })
      model.setSelection([wall.id])

      const dupedIds = clipboard.duplicate()
      expect(dupedIds).toHaveLength(1)
      expect(dupedIds[0]).not.toBe(wall.id)
      expect(clipboard.getClipboardLength()).toBe(0)

      const home = store.getHome()
      expect(home.walls).toHaveLength(2)
      const pasted = home.walls.find((w) => w.id === dupedIds[0])!
      expect(pasted.xStart).toBe(wall.xStart + PASTE_OFFSET_CM)
      expect(pasted.yStart).toBe(wall.yStart + PASTE_OFFSET_CM)
    })
  })

  describe('works across item types', () => {
    it('copy-paste furniture', () => {
      const { store, model, clipboard } = setup()
      const f = model.addFurniture({ name: 'Sofa', x: 50, y: 50, width: 200, depth: 80, height: 80, elevation: 0, angleDeg: 0 })
      model.setSelection([f.id])
      clipboard.copy()

      const pastedIds = clipboard.paste()
      expect(pastedIds).toHaveLength(1)
      const home = store.getHome()
      expect(home.furniture).toHaveLength(2)
      const pasted = home.furniture.find((fi) => fi.id === pastedIds[0])!
      expect(pasted.x).toBe(f.x + PASTE_OFFSET_CM)
      expect(pasted.y).toBe(f.y + PASTE_OFFSET_CM)
      expect(pasted.name).toBe(f.name)
    })

    it('copy-paste room', () => {
      const { store, model, clipboard } = setup()
      const r = model.addRoom([[0, 0], [100, 0], [100, 100], [0, 100]])
      model.setSelection([r.id])
      clipboard.copy()

      const pastedIds = clipboard.paste()
      expect(pastedIds).toHaveLength(1)
      const home = store.getHome()
      expect(home.rooms).toHaveLength(2)
      const pasted = home.rooms.find((rm) => rm.id === pastedIds[0])!
      expect(pasted.points[0]).toEqual([0 + PASTE_OFFSET_CM, 0 + PASTE_OFFSET_CM])
    })
  })
})
