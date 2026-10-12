import { FurnitureTooLargeError } from '../core/furniture-clearance'
import { showToast } from './toast'

const DISMISS_MS = 8000

let current: { message: string; el: HTMLElement } | null = null

/** Tell the user a furniture edit was refused because the piece cannot fit in its room. */
export function reportFurnitureRejection(err: FurnitureTooLargeError): void {
  if (current && current.message === err.message && current.el.isConnected) return
  const el = showToast('error', 'Furniture is too large for this room', err.message)
  current = { message: err.message, el }
  setTimeout(() => el.remove(), DISMISS_MS)
}

/**
 * Run a furniture-mutating UI action. If the model refuses it because the piece
 * is bigger than its room (the mutation is already rolled back, so nothing
 * changed), show the reason and return undefined. Any other error propagates.
 */
export function guardFurnitureEdit<T>(action: () => T): T | undefined {
  try {
    return action()
  } catch (err) {
    if (err instanceof FurnitureTooLargeError) {
      reportFurnitureRejection(err)
      return undefined
    }
    throw err
  }
}
