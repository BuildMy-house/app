import { describe, expect, it } from 'vitest'
import { HomeStore } from './store'
import { HomeModel, ModelError } from './model'
import { WALL_TEXTURES, getDefaultFloorColor } from './home'
import { HomelyCommandHandler } from '../automation/homely-handler'
import { serializeForSave, parseHomeFile } from '../services/adapters/home-persistence'

function makeStore() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  return { store, model }
}

describe('wall texture schema', () => {
  it('addWall leaves leftSideTextureId undefined when omitted', () => {
    const { model } = makeStore()
    const wall = model.addWall({
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
    })
    expect(wall.leftSideTextureId).toBeUndefined()
    expect(wall.rightSideTextureId).toBeUndefined()
  })

  it('addWall leaves leftSideTextureId undefined when omitted but keeps explicit rightSideTextureId', () => {
    const { model } = makeStore()
    const wall = model.addWall({
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
      rightSideTextureId: 'wood-oak',
    })
    expect(wall.leftSideTextureId).toBeUndefined()
    expect(wall.rightSideTextureId).toBe('wood-oak')
  })

  it('addWall leaves rightSideTextureId undefined when omitted but keeps explicit leftSideTextureId', () => {
    const { model } = makeStore()
    const wall = model.addWall({
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
      leftSideTextureId: 'concrete',
    })
    expect(wall.leftSideTextureId).toBe('concrete')
    expect(wall.rightSideTextureId).toBeUndefined()
  })

  it('addWall accepts null texture ids without applying default', () => {
    const { model } = makeStore()
    const wall = model.addWall({
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
      leftSideTextureId: null,
      rightSideTextureId: null,
    })
    expect(wall.leftSideTextureId).toBeNull()
    expect(wall.rightSideTextureId).toBeNull()
  })

  it('addWall preserves explicit valid texture id', () => {
    const { model } = makeStore()
    const wall = model.addWall({
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
      leftSideTextureId: 'wood-oak',
      rightSideTextureId: 'concrete',
    })
    expect(wall.leftSideTextureId).toBe('wood-oak')
    expect(wall.rightSideTextureId).toBe('concrete')
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

describe('automation add_wall texture defaults', () => {
  it('add_wall with omitted texture ids leaves both undefined in the store (no baked default)', () => {
    const store = new HomeStore()
    const handler = new HomelyCommandHandler(store)
    const result = handler.execute('add_wall', {
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
    })
    expect(result.ok).toBe(true)
    const wall = store.getHome().walls[0]!
    expect(wall.leftSideTextureId).toBeUndefined()
    expect(wall.rightSideTextureId).toBeUndefined()
  })

  it('add_wall with explicit null texture ids keeps null (no default)', () => {
    const store = new HomeStore()
    const handler = new HomelyCommandHandler(store)
    const result = handler.execute('add_wall', {
      xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7,
      leftSideTextureId: null,
      rightSideTextureId: null,
    })
    expect(result.ok).toBe(true)
    const wall = store.getHome().walls[0]!
    expect(wall.leftSideTextureId).toBeNull()
    expect(wall.rightSideTextureId).toBeNull()
  })
})

describe('room floor color defaults', () => {
  it('addRoom with omitted floorColor resolves to getDefaultFloorColor(home)', () => {
    const { store, model } = makeStore()
    const room = model.addRoom([[0, 0], [100, 0], [100, 100]])
    expect(room.floorColor).toBe(getDefaultFloorColor(store.getHome()))
    expect(room.floorColor).not.toBeNull()
  })

  it('addRoom with explicit null floorColor keeps null (escape hatch)', () => {
    const { model } = makeStore()
    const room = model.addRoom([[0, 0], [100, 0], [100, 100]], { floorColor: null })
    expect(room.floorColor).toBeNull()
  })

  it('addRoom with explicit floorColor keeps the given value', () => {
    const { model } = makeStore()
    const room = model.addRoom([[0, 0], [100, 0], [100, 100]], { floorColor: 0xff0000 })
    expect(room.floorColor).toBe(0xff0000)
  })
})

describe('room floor texture defaults', () => {
  it('addRoom defaults floorTextureId to wood-oak when omitted', () => {
    const { model } = makeStore()
    const room = model.addRoom([[0, 0], [100, 0], [100, 100]])
    expect(room.floorTextureId).toBe('wood-oak')
  })

  it('addRoom with explicit null floorTextureId keeps null (escape hatch)', () => {
    const { model } = makeStore()
    const room = model.addRoom([[0, 0], [100, 0], [100, 100]], { floorTextureId: null })
    expect(room.floorTextureId).toBeNull()
  })

  it('addRoom preserves explicit valid texture id', () => {
    const { model } = makeStore()
    const room = model.addRoom([[0, 0], [100, 0], [100, 100]], { floorTextureId: 'tile-floor' })
    expect(room.floorTextureId).toBe('tile-floor')
  })

  it('addRoom rejects unknown texture id', () => {
    const { model } = makeStore()
    expect(() =>
      model.addRoom([[0, 0], [100, 0], [100, 100]], { floorTextureId: 'nonexistent' as never }),
    ).toThrow(ModelError)
  })

  it('updateRoom accepts valid texture id', () => {
    const { model } = makeStore()
    const room = model.addRoom([[0, 0], [100, 0], [100, 100]])
    const updated = model.updateRoom(room.id, { floorTextureId: 'carpet' })
    expect(updated.floorTextureId).toBe('carpet')
  })

  it('updateRoom rejects invalid texture id', () => {
    const { model } = makeStore()
    const room = model.addRoom([[0, 0], [100, 0], [100, 100]])
    expect(() =>
      model.updateRoom(room.id, { floorTextureId: 'bad' as never }),
    ).toThrow(ModelError)
  })

  it('updateRoom can clear texture id to null', () => {
    const { model } = makeStore()
    const room = model.addRoom([[0, 0], [100, 0], [100, 100]])
    const updated = model.updateRoom(room.id, { floorTextureId: null })
    expect(updated.floorTextureId).toBeNull()
  })

  it('floorTextureId survives serialize round-trip', () => {
    const { store, model } = makeStore()
    model.addRoom([[0, 0], [100, 0], [100, 100]], { floorTextureId: 'tile-floor' })
    const serialized = serializeForSave(store.getHome())
    const json = JSON.parse(serialized)
    expect(json.rooms[0]!.floorTextureId).toBe('tile-floor')

    const parsed = parseHomeFile(serialized)
    expect(parsed.rooms[0]!.floorTextureId).toBe('tile-floor')
  })
})

describe('automation add_room texture defaults', () => {
  it('add_room with omitted floorTextureId lands wood-oak in the store', () => {
    const store = new HomeStore()
    const handler = new HomelyCommandHandler(store)
    const result = handler.execute('add_room', {
      points: [[0, 0], [100, 0], [100, 100]],
    })
    expect(result.ok).toBe(true)
    expect(store.getHome().rooms[0]!.floorTextureId).toBe('wood-oak')
  })

  it('add_room with explicit floorTextureId is honored', () => {
    const store = new HomeStore()
    const handler = new HomelyCommandHandler(store)
    const result = handler.execute('add_room', {
      points: [[0, 0], [100, 0], [100, 100]],
      floorTextureId: 'concrete',
    })
    expect(result.ok).toBe(true)
    expect(store.getHome().rooms[0]!.floorTextureId).toBe('concrete')
  })
})
