import { describe, expect, it } from 'vitest'
import { HomeModel, ModelError } from '../src/core/model'
import { HomeStore } from '../src/core/store'

function wallInput() {
  return { xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 10 }
}

function furnitureInput() {
  return { name: 'table', x: 10, y: 10, angleDeg: 0, width: 100, depth: 60, height: 75, elevation: 0 }
}

describe('model-layer dimension validation (M28)', () => {
  describe('addWall', () => {
    it('rejects zero and sub-minimum thickness', () => {
      const model = new HomeModel(new HomeStore())
      expect(() => model.addWall({ ...wallInput(), thickness: 0 })).toThrow(ModelError)
      expect(() => model.addWall({ ...wallInput(), thickness: 0.05 })).toThrow(ModelError)
      expect(model.getStore().getHome().walls).toHaveLength(0)
    })

    it('rejects sub-minimum height', () => {
      const model = new HomeModel(new HomeStore())
      expect(() => model.addWall({ ...wallInput(), height: 0 })).toThrow(ModelError)
      expect(() => model.addWall({ ...wallInput(), height: 0.9 })).toThrow(ModelError)
      expect(model.getStore().getHome().walls).toHaveLength(0)
    })

    it('accepts thickness at the 0.1 minimum and height at the 1 minimum', () => {
      const model = new HomeModel(new HomeStore())
      const w = model.addWall({ ...wallInput(), thickness: 0.1, height: 1 })
      expect(w.thickness).toBe(0.1)
      expect(w.height).toBe(1)
    })
  })

  describe('updateWall', () => {
    it('rejects patches that would set thickness or height below minimums', () => {
      const store = new HomeStore()
      const model = new HomeModel(store)
      const wall = model.addWall(wallInput())
      const before = JSON.stringify(store.getHome())

      expect(() => model.updateWall(wall.id, { thickness: -1 })).toThrow(/thickness/)
      expect(() => model.updateWall(wall.id, { thickness: 0.05 })).toThrow(/thickness/)
      expect(() => model.updateWall(wall.id, { height: 0.5 })).toThrow(/height/)
      expect(JSON.stringify(store.getHome())).toBe(before)
    })

    it('accepts valid minimum updates', () => {
      const model = new HomeModel(new HomeStore())
      const wall = model.addWall(wallInput())
      model.updateWall(wall.id, { thickness: 0.1, height: 1 })
      const updated = model.getStore().getHome().walls[0]!
      expect(updated.thickness).toBe(0.1)
      expect(updated.height).toBe(1)
    })
  })

  describe('addFurniture', () => {
    it('rejects zero and negative width/depth', () => {
      const model = new HomeModel(new HomeStore())
      expect(() => model.addFurniture({ ...furnitureInput(), width: -1 })).toThrow(/width/)
      expect(() => model.addFurniture({ ...furnitureInput(), depth: 0 })).toThrow(/depth/)
      expect(model.getStore().getHome().furniture).toHaveLength(0)
    })

    it('rejects dimensions below the 0.1 minimum', () => {
      const model = new HomeModel(new HomeStore())
      expect(() => model.addFurniture({ ...furnitureInput(), width: 0.05 })).toThrow(/width/)
      expect(() => model.addFurniture({ ...furnitureInput(), depth: 0.05 })).toThrow(/depth/)
      expect(() => model.addFurniture({ ...furnitureInput(), height: 0.05 })).toThrow(/height/)
    })

    it('normalizes out-of-range angleDeg at creation', () => {
      const model = new HomeModel(new HomeStore())
      const f = model.addFurniture({ ...furnitureInput(), angleDeg: 370 })
      expect(f.angleDeg).toBe(10)
      expect(model.getStore().getHome().furniture[0]!.angleDeg).toBe(10)
    })

    it('accepts dimensions at the 0.1 minimum', () => {
      const model = new HomeModel(new HomeStore())
      const f = model.addFurniture({ ...furnitureInput(), width: 0.1, depth: 0.1, height: 0.1 })
      expect(f.width).toBe(0.1)
      expect(f.depth).toBe(0.1)
      expect(f.height).toBe(0.1)
    })
  })

  describe('updateFurniture', () => {
    it('rejects patches that would set width/depth/height below 0.1', () => {
      const store = new HomeStore()
      const model = new HomeModel(store)
      const f = model.addFurniture(furnitureInput())
      const before = JSON.stringify(store.getHome())

      expect(() => model.updateFurniture(f.id, { width: -1 })).toThrow(/width/)
      expect(() => model.updateFurniture(f.id, { depth: 0 })).toThrow(/depth/)
      expect(() => model.updateFurniture(f.id, { height: 0.05 })).toThrow(/height/)
      expect(JSON.stringify(store.getHome())).toBe(before)
    })

    it('normalizes out-of-range angleDeg on update', () => {
      const model = new HomeModel(new HomeStore())
      const f = model.addFurniture(furnitureInput())
      model.updateFurniture(f.id, { angleDeg: -450 })
      expect(model.getStore().getHome().furniture[0]!.angleDeg).toBe(-90)
    })

    it('accepts valid minimum updates', () => {
      const model = new HomeModel(new HomeStore())
      const f = model.addFurniture(furnitureInput())
      model.updateFurniture(f.id, { width: 0.1, depth: 0.1, height: 0.1 })
      const updated = model.getStore().getHome().furniture[0]!
      expect(updated.width).toBe(0.1)
      expect(updated.depth).toBe(0.1)
      expect(updated.height).toBe(0.1)
    })
  })
})
