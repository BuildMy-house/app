/**
 * Lightweight, non-blocking feedback toasts. Used at the point of an action
 * (e.g. Save) to confirm success or explain a failure — callers must only
 * show one AFTER the real outcome is known.
 */

export type ToastKind = 'success' | 'error'

const SUCCESS_MS = 4000

function ensureHost(): HTMLDivElement {
  let host = document.getElementById('toast-host') as HTMLDivElement | null
  if (!host) {
    host = document.createElement('div')
    host.id = 'toast-host'
    document.body.appendChild(host)
  }
  return host
}

/**
 * Show a toast. Success toasts auto-dismiss; error toasts stay until
 * dismissed so the user can read and act on them. Errors use role="alert"
 * (announced assertively), success uses role="status".
 */
export function showToast(kind: ToastKind, message: string, detail?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = `toast toast-${kind}`
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status')

  const text = document.createElement('div')
  text.className = 'toast-message'
  text.textContent = message
  el.appendChild(text)

  if (detail) {
    const d = document.createElement('div')
    d.className = 'toast-detail'
    d.textContent = detail
    el.appendChild(d)
  }

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'toast-close'
  close.setAttribute('aria-label', 'Dismiss')
  close.textContent = '×'
  close.addEventListener('click', () => el.remove())
  el.appendChild(close)

  ensureHost().appendChild(el)
  if (kind === 'success') setTimeout(() => el.remove(), SUCCESS_MS)
  return el
}

/** Turn an unknown thrown value into a user-facing reason string. */
export function errorReason(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err)
}
