import { describe, expect, it } from 'vitest'
import { HomeStore } from './store'
import { HomeModel, ModelError } from './model'
import { serializeForSave, parseHomeFile } from '../services/adapters/home-persistence'

function makeStore() {
  const store = new HomeStore()
  const model = new HomeModel(store)
  return { store, model }
}

function requiredFurnitureFields() {
  return {
    name: 'Sofa',
    x: 100,
    y: 200,
    angleDeg: 0,
    width: 80,
    depth: 40,
    height: 50,
    elevation: 0,
  }
}

describe('furniture texture schema', () => {
  it('addFurniture accepts valid textureId', () => {
    const { model } = makeStore()
    const f = model.addFurniture({
      ...requiredFurnitureFields(),
      textureId: 'wood-oak',
    })
    expect(f.textureId).toBe('wood-oak')
  })

  it('addFurniture accepts null textureId', () => {
    const { model } = makeStore()
    const f = model.addFurniture({
      ...requiredFurnitureFields(),
      textureId: null,
    })
    expect(f.textureId).toBeNull()
  })

  it('addFurniture accepts undefined textureId (omitted)', () => {
    const { model } = makeStore()
    const f = model.addFurniture({
      ...requiredFurnitureFields(),
    })
    expect(f.textureId).toBeNull()
  })

  it('addFurniture rejects unknown texture id', () => {
    const { model } = makeStore()
    expect(() =>
      model.addFurniture({
        ...requiredFurnitureFields(),
        textureId: 'nonexistent' as never,
      }),
    ).toThrow(ModelError)
  })

  it('updateFurniture accepts valid texture id', () => {
    const { model } = makeStore()
    const f = model.addFurniture(requiredFurnitureFields())
    const updated = model.updateFurniture(f.id, { textureId: 'carpet' })
    expect(updated.textureId).toBe('carpet')
  })

  it('updateFurniture rejects invalid texture id', () => {
    const { model } = makeStore()
    const f = model.addFurniture(requiredFurnitureFields())
    expect(() =>
      model.updateFurniture(f.id, { textureId: 'bad' as never }),
    ).toThrow(ModelError)
  })

  it('updateFurniture can clear texture id to null', () => {
    const { model } = makeStore()
    const f = model.addFurniture({
      ...requiredFurnitureFields(),
      textureId: 'wood-oak',
    })
    const updated = model.updateFurniture(f.id, { textureId: null })
    expect(updated.textureId).toBeNull()
  })

  it('texture id survives serialize round-trip', () => {
    const { store, model } = makeStore()
    model.addFurniture({
      ...requiredFurnitureFields(),
      textureId: 'wood-oak',
    })
    const serialized = serializeForSave(store.getHome())
    const json = JSON.parse(serialized)
    expect(json.furniture[0]!.textureId).toBe('wood-oak')

    const parsed = parseHomeFile(serialized)
    expect(parsed.furniture[0]!.textureId).toBe('wood-oak')
  })
})
