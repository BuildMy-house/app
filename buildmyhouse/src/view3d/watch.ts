import type { HomeStore } from '../core/store'

export type StoreListener = () => void

type StoreMutators = Pick<HomeStore, 'apply' | 'undo' | 'redo' | 'resetToEmpty'>

/**
 * Live-sync shim over the pure HomeStore: core/store (owned by B2) has no
 * subscription API, so view code shadows the four mutating instance methods.
 * undo()/redo() notify only when they actually changed state (they return
 * false on an empty stack). Returns an unobserve fn restoring the originals.
 */
export function observeStore(store: HomeStore, listener: StoreListener): () => void {
  const original: StoreMutators = {
    apply: store.apply.bind(store),
    undo: store.undo.bind(store),
    redo: store.redo.bind(store),
    resetToEmpty: store.resetToEmpty.bind(store),
  }
  const patchable = store as StoreMutators

  patchable.apply = (mutate) => {
    original.apply(mutate)
    listener()
  }
  patchable.undo = () => {
    const changed = original.undo()
    if (changed) listener()
    return changed
  }
  patchable.redo = () => {
    const changed = original.redo()
    if (changed) listener()
    return changed
  }
  patchable.resetToEmpty = () => {
    original.resetToEmpty()
    listener()
  }

  return () => {
    patchable.apply = original.apply
    patchable.undo = original.undo
    patchable.redo = original.redo
    patchable.resetToEmpty = original.resetToEmpty
  }
}
