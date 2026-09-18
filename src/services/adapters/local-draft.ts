import type { NormalizedHomeState } from '../../core/home'
import { serializeForSave, parseHomeFile } from './home-persistence'

/**
 * Browser-local autosave of whatever is currently open in the editor, so a
 * refresh (or accidental tab close) never loses in-progress work — independent
 * of, and in addition to, the explicit File/Account save flows. Keyed apart
 * from project-store.ts's automation-command slots and home-persistence's
 * disk/account round-trips: this is a single always-on "current document"
 * slot, not a named project.
 */

const DRAFT_KEY = 'homely-local-draft'

function storage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    /* access can throw in sandboxed contexts */
  }
  return null
}

export function saveDraft(home: NormalizedHomeState): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(DRAFT_KEY, serializeForSave(home))
  } catch {
    /* quota / serialization failure — draft simply isn't updated this tick */
  }
}

export function loadDraft(): NormalizedHomeState | null {
  const s = storage()
  if (!s) return null
  try {
    const raw = s.getItem(DRAFT_KEY)
    return raw ? parseHomeFile(raw) : null
  } catch {
    return null
  }
}

export function clearDraft(): void {
  const s = storage()
  if (!s) return
  try {
    s.removeItem(DRAFT_KEY)
  } catch {
    /* ignore */
  }
}
