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
 * patchNonUndoable() is deliberately NOT observed generically here: it's
 * also used for high-frequency UI-only state (e.g. engine.ts mirrors every
 * tool switch into home.activeTool this way), and computeSceneUpdates() only
 * diffs walls/furniture/rooms/levels — a patch that touches none of those
 * comes back as zero updates, which onStoreChanged() currently treats as
 * "fall back to a full rebuild". Observing patchNonUndoable as-is would turn
 * every tool-button click into a full 3D scene teardown+rebuild.
 *
 * Preference-only edits (default wall material, ground color/texture, etc.)
 * also go through patchNonUndoable, and computeSceneUpdates() has no way to
 * see them (it only diffs geometry-bearing fields) — MAT-T10C fixes this
 * with an explicit, opt-in signal instead of blanket observation: see
 * notifyScenePreferenceChange()/onScenePreferenceChange() below. Preference-
 * writing call sites call notifyScenePreferenceChange() themselves right
 * after the patchNonUndoable that changed something scene-relevant; View3D
 * subscribes once via onScenePreferenceChange() and does a full rebuild()
 * (there's no incremental delta path for these fields, so a rebuild is the
 * correct — and, since preference edits are low-frequency, cheap enough —
 * response).
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

/**
 * Explicit signal channel for scene-relevant preference-only edits (default
 * wall materials, ground color/texture, floor/ceiling defaults) — see the
 * observeStore() comment above for why these are NOT folded into the
 * generic patchNonUndoable observation. Preference-writing code (e.g.
 * patchHomePreferences() in ui/MaterialsPreferencesPanel.ts, and the ground
 * color/texture patch in main.ts's openPreferences()) calls
 * notifyScenePreferenceChange() right after the store patch; View3D
 * subscribes via onScenePreferenceChange() in its constructor and
 * unsubscribes in dispose().
 */
const scenePreferenceListeners = new Set<StoreListener>()

export function notifyScenePreferenceChange(): void {
  for (const listener of scenePreferenceListeners) listener()
}

export function onScenePreferenceChange(listener: StoreListener): () => void {
  scenePreferenceListeners.add(listener)
  return () => scenePreferenceListeners.delete(listener)
}
