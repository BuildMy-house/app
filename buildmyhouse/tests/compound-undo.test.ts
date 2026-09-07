// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { HomeStore } from '../src/core/store'
import { HomeModel } from '../src/core/model'

/**
 * M43 regression test: placing furniture via onPlace wraps addFurniture +
 * setSelection in a single compound edit so ONE undo fully reverts the action.
 *
 * Before the fix, each call produced its own undo step — undo removed the
 * furniture but left a stale selection entry, requiring two undos to fully
 * revert. This test proves the compound-edit pattern that the fix uses.
 */

function makeFurniture() {
  return {
    name: 'Sofa',
    catalogId: null as string | null,
    x: 100,
    y: 200,
    angleDeg: 0,
    width: 200,
    depth: 80,
    height: 75,
    elevation: 0,
    color: null,
    doorOrWindow: false,
    modelPath: null,
    levelRef: null as string | null,
  }
}

describe('compound undo — furniture placement (M43)', () => {
  it('addFurniture + setSelection in compound edit reverts with ONE undo', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)

    expect(store.getHome().furniture.length).toBe(0)
    expect(store.canUndo()).toBe(false)

    // Replicate the exact onPlace code path with compound edit
    store.beginCompoundEdit()
    const placed = model.addFurniture(makeFurniture())
    model.setSelection([placed.id])
    store.endCompoundEdit()

    expect(store.getHome().furniture.length).toBe(1)
    expect(store.canUndo()).toBe(true)

    // ONE undo should fully revert both mutations
    const didUndo = store.undo()
    expect(didUndo).toBe(true)
    expect(store.getHome().furniture.length).toBe(0)
    expect(store.canUndo()).toBe(false)
  })

  it('without compound edit, addFurniture + setSelection needs TWO undos', () => {
    const store = new HomeStore()
    const model = new HomeModel(store)

    // Replicate the OLD buggy code path: no compound edit
    const placed = model.addFurniture(makeFurniture())
    model.setSelection([placed.id])

    expect(store.getHome().furniture.length).toBe(1)

    // First undo only reverts setSelection — furniture still present
    store.undo()
    expect(store.getHome().furniture.length).toBe(1)

    // Second undo reverts addFurniture — furniture gone
    store.undo()
    expect(store.getHome().furniture.length).toBe(0)
  })
})
