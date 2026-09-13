import type { AuthAdapter } from '../services/auth'

/**
 * Modal for changing the password of the currently authenticated user.
 * Reuses the same overlay/dialog styling as AuthDialog.
 */
export class ChangePasswordDialog {
  private overlay: HTMLDivElement
  private auth: AuthAdapter
  private onSuccess: () => void
  private escHandler: ((e: KeyboardEvent) => void) | null = null

  constructor(auth: AuthAdapter, onSuccess: () => void) {
    this.auth = auth
    this.onSuccess = onSuccess
    this.overlay = document.createElement('div')
    this.overlay.className = 'prefs-overlay'
  }

  open(): void {
    this.render()
    document.body.appendChild(this.overlay)
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.close()
      }
    }
    window.addEventListener('keydown', this.escHandler)
  }

  private render(): void {
    this.overlay.innerHTML = `
      <form class="prefs-dialog auth-dialog">
        <h3>Change Password</h3>
        <div class="prefs-row">
          <label for="cp-current">Current Password</label>
          <input id="cp-current" name="currentPassword" type="password" required autocomplete="current-password" />
        </div>
        <div class="prefs-row">
          <label for="cp-new">New Password</label>
          <input id="cp-new" name="newPassword" type="password" required minlength="8" autocomplete="new-password" />
        </div>
        <div class="prefs-row">
          <label for="cp-confirm">Confirm New Password</label>
          <input id="cp-confirm" name="confirmPassword" type="password" required minlength="8" autocomplete="new-password" />
        </div>
        <div class="auth-error" role="alert"></div>
        <div class="prefs-actions">
          <button type="button" class="prefs-btn prefs-cancel">Cancel</button>
          <button type="submit" class="prefs-btn prefs-ok auth-submit">Change Password</button>
        </div>
      </form>
    `

    this.overlay.querySelector('.prefs-cancel')!.addEventListener('click', () => this.close())
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close()
    })
    this.overlay.querySelector<HTMLFormElement>('form')!.addEventListener('submit', (e) => {
      e.preventDefault()
      void this.submit()
    })
  }

  private close(): void {
    if (this.escHandler) {
      window.removeEventListener('keydown', this.escHandler)
      this.escHandler = null
    }
    this.overlay.remove()
  }

  private async submit(): Promise<void> {
    const current = this.overlay.querySelector<HTMLInputElement>('#cp-current')?.value ?? ''
    const newPw = this.overlay.querySelector<HTMLInputElement>('#cp-new')?.value ?? ''
    const confirm = this.overlay.querySelector<HTMLInputElement>('#cp-confirm')?.value ?? ''
    const errorEl = this.overlay.querySelector<HTMLDivElement>('.auth-error')
    const submitBtn = this.overlay.querySelector<HTMLButtonElement>('.auth-submit')
    const setError = (msg: string): void => {
      if (errorEl) errorEl.textContent = msg
    }

    if (!current) { setError('Please enter your current password.'); return }
    if (newPw.length < 8) { setError('New password must be at least 8 characters.'); return }
    if (newPw !== confirm) { setError('New passwords do not match.'); return }
    if (newPw === current) { setError('New password must differ from current password.'); return }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Please wait…' }
    try {
      await this.auth.changePassword(current, newPw)
      this.close()
      this.onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Change Password' }
    }
  }
}
