import { describe, expect, it } from 'vitest'
import { HomeStore } from './store'
import { HomeModel, ModelError } from './model'
import { WALL_TEXTURES } from './home'
import { serializeForSave, parseHomeFile } from '../services/adapters/home-persistence'

function makeStore() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  return { store, model }
}

describe('wall texture schema', () => {
  it('addWall accepts valid leftSideTextureId', () => {
    const { model } = makeStore()
    const wall = model.addWall({
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
      leftSideTextureId: 'wood-oak',
    })
    expect(wall.leftSideTextureId).toBe('wood-oak')
    expect(wall.rightSideTextureId).toBeUndefined()
  })

  it('addWall accepts valid rightSideTextureId', () => {
    const { model } = makeStore()
    const wall = model.addWall({
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
      rightSideTextureId: 'concrete',
    })
    expect(wall.rightSideTextureId).toBe('concrete')
  })

  it('addWall accepts null texture ids', () => {
    const { model } = makeStore()
    const wall = model.addWall({
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
      leftSideTextureId: null,
      rightSideTextureId: null,
    })
    expect(wall.leftSideTextureId).toBeNull()
    expect(wall.rightSideTextureId).toBeNull()
  })

  it('addWall rejects unknown texture id', () => {
    const { model } = makeStore()
    expect(() =>
      model.addWall({
        xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
        leftSideTextureId: 'nonexistent' as never,
      }),
    ).toThrow(ModelError)
  })

  it('updateWall accepts valid texture id', () => {
    const { model } = makeStore()
    const wall = model.addWall({
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
    })
    const updated = model.updateWall(wall.id, { leftSideTextureId: 'carpet' })
    expect(updated.leftSideTextureId).toBe('carpet')
  })

  it('updateWall rejects invalid texture id', () => {
    const { model } = makeStore()
    const wall = model.addWall({
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
    })
    expect(() =>
      model.updateWall(wall.id, { leftSideTextureId: 'bad' as never }),
    ).toThrow(ModelError)
  })

  it('updateWall can clear texture id to null', () => {
    const { model } = makeStore()
    const wall = model.addWall({
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
      leftSideTextureId: 'wood-oak',
    })
    const updated = model.updateWall(wall.id, { leftSideTextureId: null })
    expect(updated.leftSideTextureId).toBeNull()
  })

  it('all catalog texture ids are valid', () => {
    const ids = WALL_TEXTURES.map((t) => t.id)
    expect(ids).toContain('carpet')
    expect(ids).toContain('concrete')
    expect(ids).toContain('plaster-white')
    expect(ids).toContain('tile-floor')
    expect(ids).toContain('wood-oak')
    expect(ids).toContain('wood-pine')
  })

  it('texture ids survive serialize round-trip', () => {
    const { store, model } = makeStore()
    model.addWall({
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
      leftSideTextureId: 'wood-oak',
      rightSideTextureId: 'concrete',
    })
    const serialized = serializeForSave(store.getHome())
    const json = JSON.parse(serialized)
    expect(json.walls[0]!.leftSideTextureId).toBe('wood-oak')
    expect(json.walls[0]!.rightSideTextureId).toBe('concrete')

    const parsed = parseHomeFile(serialized)
    expect(parsed.walls[0]!.leftSideTextureId).toBe('wood-oak')
    expect(parsed.walls[0]!.rightSideTextureId).toBe('concrete')
  })
})
