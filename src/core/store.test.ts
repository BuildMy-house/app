import { describe, expect, it } from 'vitest'
import { HomeStore } from './store'
import { HomeModel } from './model'

describe('peek()', () => {
  it('returns correct content counts without cloning', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 })
    model.addWall({ xStart: 100, yStart: 0, xEnd: 100, yEnd: 100, thickness: 7 })
    model.addFurniture({ name: 'Sofa', x: 50, y: 50, width: 200, depth: 80, height: 80, elevation: 0, angleDeg: 0 })
    model.addRoom([[0, 0], [100, 0], [100, 100], [0, 100]])
    model.addLevel({ name: 'L2', elevation: 280, floorThickness: 20, height: 250, visible: true, viewable: true })
    expect(store.getContentCounts()).toEqual({ walls: 2, furniture: 1, rooms: 1, levels: 1 })
  })

  it('returns the exact same reference on repeated calls (no clone)', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 })
    const first = store.peek()
    const second = store.peek()
    expect(second).toBe(first)
    expect(second.walls).toBe(first.walls)
  })
})
