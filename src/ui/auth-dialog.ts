import type { AuthAdapter } from '../services/auth'

/**
 * Login/register modal mirroring PreferencesDialog's overlay pattern. Native
 * form validation (type=email, required, minlength=8) supplies the pre-flight
 * checks; server-side errors (wrong password, duplicate email, rate limit)
 * render in the inline error area. On success it closes and invokes
 * onAuthenticated so callers can refresh auth state and resume a deferred
 * action.
 */
export class AuthDialog {
  private overlay: HTMLDivElement
  private auth: AuthAdapter
  private onAuthenticated: () => void
  private mode: 'login' | 'register' = 'login'
  private escHandler: ((e: KeyboardEvent) => void) | null = null

  constructor(auth: AuthAdapter, onAuthenticated: () => void) {
    this.auth = auth
    this.onAuthenticated = onAuthenticated
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
    const isLogin = this.mode === 'login'
    this.overlay.innerHTML = `
      <form class="prefs-dialog auth-dialog">
        <h3>${isLogin ? 'Log In' : 'Create Account'}</h3>
        <div class="prefs-row">
          <label for="auth-email">Email</label>
          <input id="auth-email" name="email" type="email" required autocomplete="email" />
        </div>
        <div class="prefs-row">
          <label for="auth-password">Password</label>
          <input id="auth-password" name="password" type="password" required minlength="8"
            autocomplete="${isLogin ? 'current-password' : 'new-password'}" />
        </div>
        <div class="auth-error" role="alert"></div>
        <div class="prefs-actions">
          <button type="button" class="prefs-btn prefs-cancel">Cancel</button>
          <button type="submit" class="prefs-btn prefs-ok auth-submit">${isLogin ? 'Log In' : 'Register'}</button>
        </div>
        <div class="auth-toggle">
          <span>${isLogin ? 'No account?' : 'Already have an account?'}</span>
          <button type="button" class="prefs-btn auth-switch">${isLogin ? 'Create one' : 'Log in'}</button>
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
    this.overlay.querySelector('.auth-switch')!.addEventListener('click', () => {
      this.mode = this.mode === 'login' ? 'register' : 'login'
      this.render()
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
    const email = this.overlay.querySelector<HTMLInputElement>('#auth-email')?.value ?? ''
    const password = this.overlay.querySelector<HTMLInputElement>('#auth-password')?.value ?? ''
    const errorEl = this.overlay.querySelector<HTMLDivElement>('.auth-error')
    const submitBtn = this.overlay.querySelector<HTMLButtonElement>('.auth-submit')
    const setError = (msg: string): void => {
      if (errorEl) errorEl.textContent = msg
    }

    if (!email.trim()) {
      setError('Please enter your email address.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    if (submitBtn) {
      submitBtn.disabled = true
      submitBtn.textContent = 'Please wait…'
    }
    try {
      if (this.mode === 'login') await this.auth.login(email, password)
      else await this.auth.register(email, password)
      this.close()
      this.onAuthenticated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      if (submitBtn) {
        submitBtn.disabled = false
        submitBtn.textContent = this.mode === 'login' ? 'Log In' : 'Register'
      }
    }
  }
}
