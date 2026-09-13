/**
 * Promise-based replacements for native confirm()/prompt(). Native dialogs
 * can't be themed (broken in dark mode), look out of place in the Tauri shell,
 * and can't be driven from e2e automation. Mirrors the prefs-overlay pattern
 * used by AutoFloorDialog/PreferencesDialog/AuthDialog.
 */

/**
 * Wire overlay dismissal (Escape, backdrop click, Cancel/OK buttons) and call
 * `close(true)` on confirm, `close(false)` on cancel. Escape uses a capture
 * listener so the app's own Escape handling doesn't also fire underneath.
 */
function openOverlay(
  overlay: HTMLDivElement,
  onDone: (viaConfirm: boolean) => void,
  input?: HTMLInputElement,
): void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      finish(false)
    }
  }
  window.addEventListener('keydown', onKey, true)
  const finish = (viaConfirm: boolean): void => {
    window.removeEventListener('keydown', onKey, true)
    overlay.remove()
    onDone(viaConfirm)
  }
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) finish(false)
  })
  overlay.querySelector('.dialog-cancel')!.addEventListener('click', () => finish(false))
  overlay.querySelector('.dialog-confirm')!.addEventListener('click', () => finish(true))
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    }
  })
  document.body.appendChild(overlay)
  input?.focus()
  input?.select()
}

/** Yes/no confirmation. Resolves false on Cancel/Escape/backdrop. */
export function confirmDialog(message: string, confirmLabel = 'OK'): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'prefs-overlay'
    overlay.innerHTML = `
      <div class="prefs-dialog">
        <h3></h3>
        <div class="prefs-actions">
          <button type="button" class="prefs-btn dialog-cancel">Cancel</button>
          <button type="button" class="prefs-btn prefs-ok dialog-confirm"></button>
        </div>
      </div>
    `
    // textContent, not interpolation — messages embed user content (level names).
    overlay.querySelector('h3')!.textContent = message
    overlay.querySelector('.dialog-confirm')!.textContent = confirmLabel
    openOverlay(overlay, (viaConfirm) => {
      resolve(viaConfirm)
    })
  })
}

/**
 * Single text field. Resolves the entered string on OK/Enter, null on
 * Cancel/Escape/backdrop — the same contract as window.prompt.
 */
export function promptDialog(message: string, defaultValue = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'prefs-overlay'
    overlay.innerHTML = `
      <div class="prefs-dialog">
        <h3></h3>
        <div class="prefs-row">
          <input class="dialog-input" type="text" />
        </div>
        <div class="prefs-actions">
          <button type="button" class="prefs-btn dialog-cancel">Cancel</button>
          <button type="button" class="prefs-btn prefs-ok dialog-confirm">OK</button>
        </div>
      </div>
    `
    overlay.querySelector('h3')!.textContent = message
    const input = overlay.querySelector<HTMLInputElement>('.dialog-input')!
    input.value = defaultValue
    openOverlay(overlay, (viaConfirm) => {
      resolve(viaConfirm ? input.value : null)
    }, input)
  })
}
