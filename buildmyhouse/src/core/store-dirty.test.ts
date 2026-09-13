import { describe, expect, it } from 'vitest'
import { HomeStore } from './store'
import { HomeModel } from './model'
import { serializeForSave, parseHomeFile } from '../services/adapters/home-persistence'
import { createEmptyHome } from './home'

describe('dirty flag', () => {
  it('starts clean on a new store', () => {
    expect(new HomeStore().isDirty()).toBe(false)
  })

  it('flip true after a mutating apply()', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 })
    expect(store.isDirty()).toBe(true)
  })

  it('flip true after raw store.apply()', () => {
    const store = new HomeStore()
    store.apply(() => {})
    expect(store.isDirty()).toBe(true)
  })

  it('flip true after compound edit', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    store.beginCompoundEdit()
    model.addWall({ xStart: 0, yStart: 0, xEnd: 50, yEnd: 0, thickness: 7 })
    model.addWall({ xStart: 50, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 })
    store.endCompoundEdit()
    expect(store.isDirty()).toBe(true)
  })

  it('clear on resetToEmpty (File > New)', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 })
    expect(store.isDirty()).toBe(true)
    store.resetToEmpty()
    expect(store.isDirty()).toBe(false)
  })

  it('clear on loadHome (File > Open)', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 })
    expect(store.isDirty()).toBe(true)
    store.loadHome(createEmptyHome())
    expect(store.isDirty()).toBe(false)
  })

  it('clear on markClean (File > Save)', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 })
    expect(store.isDirty()).toBe(true)
    store.markClean()
    expect(store.isDirty()).toBe(false)
  })

  it('dirty persists through undo/redo cycle', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 })
    expect(store.isDirty()).toBe(true)
    store.undo()
    // undo does not clear dirty — the user made changes since last save
    expect(store.isDirty()).toBe(true)
    store.redo()
    expect(store.isDirty()).toBe(true)
  })

  it('round-trip: dirty → save → clean → mutate → dirty → load → clean', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)
    model.addWall({ xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 7 })
    expect(store.isDirty()).toBe(true)

    // Simulate save: serialize then mark clean
    const json = serializeForSave(store.getHome())
    store.markClean()
    expect(store.isDirty()).toBe(false)

    // Mutate again
    model.addWall({ xStart: 100, yStart: 0, xEnd: 100, yEnd: 100, thickness: 7 })
    expect(store.isDirty()).toBe(true)

    // Simulate open: parse saved file and load
    const home = parseHomeFile(json)
    const store2 = new HomeStore()
    store2.loadHome(home)
    expect(store2.isDirty()).toBe(false)
    expect(store2.getHome().walls).toHaveLength(1)
  })
})
