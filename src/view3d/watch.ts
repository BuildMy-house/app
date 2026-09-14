import type { HomeStore } from '../core/store'

export type StoreListener = () => void

type StoreMutators = Pick<HomeStore, 'apply' | 'undo' | 'redo' | 'resetToEmpty' | 'loadHome'>

/**
 * Live-sync shim over the pure HomeStore: core/store (owned by B2) has no
 * subscription API, so view code shadows the mutating instance methods.
 * undo()/redo() notify only when they actually changed state (they return
 * false on an empty stack). Returns an unobserve fn restoring the originals.
 *
 * loadHome() is included deliberately: File > Open / Open from My Account
 * call store.loadHome() directly (see main.ts), and without this the 3D
 * viewport and properties panel kept showing the previous document's
 * geometry until some unrelated apply()/undo()/redo() happened to fire next
 * — verified live (mesh count unchanged after loadHome(), only updated once
 * View3D.rebuild() was called explicitly).
 *
 * patchNonUndoable() is deliberately NOT included: it's also used for
 * high-frequency UI-only state (e.g. engine.ts mirrors every tool switch
 * into home.activeTool this way), and computeSceneUpdates() only diffs
 * walls/furniture/rooms/levels — a patch that touches none of those comes
 * back as zero updates, which onStoreChanged() currently treats as "fall
 * back to a full rebuild". Observing patchNonUndoable as-is would turn every
 * tool-button click into a full 3D scene teardown+rebuild. (It also carries
 * environment/preferences edits — e.g. ground color — that the 3D view
 * already fails to live-refresh; fixing that needs computeSceneUpdates to
 * know about those fields, or the specific call sites to refresh explicitly
 * — left as a follow-up rather than folded into this fix.)
 */
export function observeStore(store: HomeStore, listener: StoreListener): () => void {
  const original: StoreMutators = {
    apply: store.apply.bind(store),
    undo: store.undo.bind(store),
    redo: store.redo.bind(store),
    resetToEmpty: store.resetToEmpty.bind(store),
    loadHome: store.loadHome.bind(store),
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
  patchable.loadHome = (home) => {
    original.loadHome(home)
    listener()
  }

  return () => {
    patchable.apply = original.apply
    patchable.undo = original.undo
    patchable.redo = original.redo
    patchable.resetToEmpty = original.resetToEmpty
    patchable.loadHome = original.loadHome
  }
}
