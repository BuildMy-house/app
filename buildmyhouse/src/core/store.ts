import { createEmptyHome, type NormalizedHomeState } from './home'
import { followTopCamera } from './top-camera-follower'

/**
 * Pure home state store. Zero platform imports; all mutation goes through
 * apply() so the automation layer and the UI share one truth.
 *
 * Undo/redo is snapshot-based: every undoable mutation clones the whole home.
 * Depth-capped (SH3D keeps full history; 100 is ample for equivalence runs).
 *
 * The SH3D top-camera follower runs after every content change (apply/undo/
 * redo) — HomeController3D$TopCameraState parity. It skips camera-only
 * mutations, so explicit moves are never fought; writes are non-undoable
 * (camera placement is not an undoable edit in SH3D either).
 */
export class HomeStore {
  static readonly MAX_UNDO_DEPTH = 100

  private home: NormalizedHomeState
  private undoStack: NormalizedHomeState[] = []
  private redoStack: NormalizedHomeState[] = []
  private idCounter = 1
  private compoundDepth = 0
  private compoundBase: NormalizedHomeState | null = null
  private _dirty = false

  /**
   * timeZoneId feeds the compass location default (SH3D reads the OS zone);
   * injectable so tests are deterministic regardless of machine timezone.
   */
  constructor(private readonly timeZoneId?: string | null) {
    this.home = createEmptyHome(timeZoneId)
  }

  /** Deep copy with live capability flags stamped in (never stale). */
  getHome(): NormalizedHomeState {
    const clone = structuredClone(this.home)
    clone.capabilities = { canUndo: this.canUndo(), canRedo: this.canRedo() }
    return clone
  }

  /**
   * Run a mutation against a private draft of the current state and record it
   * as one undo step — only if the mutation completes without throwing, so a
   * failed op never touches history or state. Any divergent mutation clears
   * the redo stack.
   */
  apply(mutate: (draft: NormalizedHomeState) => void): void {
    const previous = this.home
    const draft = structuredClone(previous)
    mutate(draft)
    if (this.compoundDepth > 0) {
      // Inside a compound edit: state advances now (so per-item followers run
      // event-by-event) but the single undo push waits for endCompoundEdit.
      this.home = draft
      followTopCamera(this.home, previous)
      this._dirty = true
      return
    }
    this.undoStack.push(previous)
    if (this.undoStack.length > HomeStore.MAX_UNDO_DEPTH) this.undoStack.shift()
    this.redoStack = []
    this.home = draft
    followTopCamera(this.home, previous)
    this._dirty = true
  }

  /**
   * Opens a compound edit (SH3D undoSupport.beginUpdate parity): applies made
   * until the matching endCompoundEdit() collapse into ONE undo step, sealed
   * only if something actually changed. The top-camera follower still runs on
   * every inner apply, so intermediate placements match SH3D's per-event
   * behavior while undo/redo stay coarse-grained.
   */
  beginCompoundEdit(): void {
    if (this.compoundDepth === 0) this.compoundBase = this.home
    this.compoundDepth++
  }

  endCompoundEdit(): void {
    if (this.compoundDepth === 0) {
      throw new Error('endCompoundEdit without matching beginCompoundEdit')
    }
    this.compoundDepth--
    if (this.compoundDepth > 0) return
    const base = this.compoundBase
    this.compoundBase = null
    // patchNonUndoable-only batches mutate home in place (same reference);
    // reference equality means nothing undoable happened — no history entry.
    if (base !== null && this.home !== base) {
      this.undoStack.push(base)
      if (this.undoStack.length > HomeStore.MAX_UNDO_DEPTH) this.undoStack.shift()
      this.redoStack = []
    }
  }

  undo(): boolean {
    const previous = this.undoStack.pop()
    if (!previous) return false
    const current = this.home
    this.redoStack.push(structuredClone(current))
    this.home = previous
    followTopCamera(this.home, current)
    return true
  }

  redo(): boolean {
    const next = this.redoStack.pop()
    if (!next) return false
    const current = this.home
    this.undoStack.push(structuredClone(current))
    this.home = next
    followTopCamera(this.home, current)
    return true
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  /** True after any undoable mutation since the last save/load/new. */
  isDirty(): boolean {
    return this._dirty
  }

  /** Clear dirty flag — call after successful save or load. */
  markClean(): void {
    this._dirty = false
  }

  /**
   * Mutates view-ish state (e.g. activeTool) WITHOUT recording an undo step —
   * tool switches are not document edits (SH3D mode changes are not undoable).
   * Deliberately does NOT run the top-camera follower (not a content change).
   */
  patchNonUndoable(mutate: (draft: NormalizedHomeState) => void): void {
    mutate(this.home)
  }

  /** Opaque, creation-ordered ids; harness matches by ledger order, not format. */
  generateId(prefix: string): string {
    return `${prefix}-${this.idCounter++}`
  }

  /** new_home semantics: reset to empty AND clear undo/redo + id counter.
   * SH3D NEW_HOME installs a brand-new default top camera — no follower run
   * (createEmptyHome already carries it); orbiting would wrongly preserve the
   * old distance. */
  resetToEmpty(): void {
    this.home = createEmptyHome(this.timeZoneId)
    this.undoStack = []
    this.redoStack = []
    this.idCounter = 1
    // A drawing session open across automation commands is discarded with
    // the rest of the document — never sealed onto the fresh undo stack.
    this.compoundDepth = 0
    this.compoundBase = null
    this._dirty = false
  }

  /**
   * Replace the entire document (open/save round-trip). Clears undo/redo and
   * reseeds the id counter past any numeric suffixes already present so
   * subsequent creates never collide with loaded ids.
   */
  loadHome(home: NormalizedHomeState): void {
    this.home = structuredClone(home)
    this.undoStack = []
    this.redoStack = []
    this.compoundDepth = 0
    this.compoundBase = null
    this.idCounter = this.maxExistingId(this.home) + 1
    this._dirty = false
  }

  private maxExistingId(home: NormalizedHomeState): number {
    let max = 0
    const all = [
      ...home.levels,
      ...home.walls,
      ...home.rooms,
      ...home.furniture,
      ...home.dimensionLines,
      ...home.labels,
      ...home.roofs,
    ]
    for (const item of all) {
      const match = /-(\d+)$/.exec(item.id)
      if (match) max = Math.max(max, Number(match[1]))
    }
    return max
  }
}
