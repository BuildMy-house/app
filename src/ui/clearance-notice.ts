import { findClearanceViolations } from '../core/furniture-clearance'
import type { HomeStore } from '../core/store'
import { showToast } from './toast'

/**
 * Loaded homes (files, drafts, templates) restore verbatim, so they can hold
 * pieces overlapping walls or too large for their room. After a user-initiated
 * load, say so — non-blocking — and offer a one-click, one-undo-step fix.
 */
export function notifyLegacyClearance(store: HomeStore): void {
  const found = findClearanceViolations(store.peek())
  const flagged = new Set([...found.overlaps.map((o) => o.furnitureId), ...found.oversize.map((o) => o.furnitureId)])
  if (flagged.size === 0) return
  const n = flagged.size
  showToast(
    'notice',
    `${n} furniture ${n === 1 ? 'piece overlaps' : 'pieces overlap'} a wall`,
    'This home was saved before pieces were kept clear of walls.',
    {
      label: 'Fix overlaps',
      run: () => {
        const fix = store.fixFurnitureClearance()
        if (fix.unfixable.length > 0) {
          showToast(
            'error',
            `${fix.unfixable.length} ${fix.unfixable.length === 1 ? 'piece' : 'pieces'} can't be fixed automatically`,
            fix.unfixable.map((u) => u.message).join(' '),
          )
        } else {
          showToast('success', `Moved ${fix.moves.length} ${fix.moves.length === 1 ? 'piece' : 'pieces'} clear of walls (undo to revert)`)
        }
      },
    },
  )
}
