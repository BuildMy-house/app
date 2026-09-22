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
  private mode: 'login' | 'register'
  private accountType: 'personal' | 'company' = 'personal'
  private escHandler: ((e: KeyboardEvent) => void) | null = null

  constructor(auth: AuthAdapter, onAuthenticated: () => void, initialMode: 'login' | 'register' = 'login') {
    this.auth = auth
    this.onAuthenticated = onAuthenticated
    this.mode = initialMode
    this.overlay = document.createElement('div')
    this.overlay.className = 'prefs-overlay'
  }

  open(): void {
    this.render()
    document.body.appendChild(this.overlay)
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close()
    })
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
        <h3 class="auth-title"></h3>
        <div class="auth-toggle" role="group" aria-label="Account access">
          <button type="button" class="prefs-btn auth-switch" data-mode="login" aria-pressed="false">Log In</button>
          <button type="button" class="prefs-btn auth-switch" data-mode="register" aria-pressed="false">Sign Up</button>
        </div>
        <fieldset class="auth-account-type" hidden>
          <legend>Account type</legend>
          <label><input type="radio" name="accountType" value="personal" checked /> Personal</label>
          <label><input type="radio" name="accountType" value="company" /> Company</label>
        </fieldset>
        <div class="prefs-row auth-company-row" hidden>
          <label for="auth-company">Company name</label>
          <input id="auth-company" name="companyName" type="text" minlength="2" maxlength="100" autocomplete="organization" />
          <small>Creates a workspace for your company projects.</small>
        </div>
        <div class="prefs-row">
          <label for="auth-email">Email</label>
          <input id="auth-email" name="email" type="email" required autocomplete="email" />
        </div>
        <div class="prefs-row">
          <label for="auth-password">Password</label>
          <input id="auth-password" name="password" type="password" required minlength="8"
            autocomplete="current-password" />
        </div>
        <div class="prefs-row auth-confirm-row" hidden>
          <label for="auth-confirm-password">Confirm password</label>
          <input id="auth-confirm-password" name="confirmPassword" type="password" minlength="8" autocomplete="new-password" />
        </div>
        <div class="auth-error" role="alert"></div>
        <div class="prefs-actions">
          <button type="button" class="prefs-btn prefs-cancel">Cancel</button>
          <button type="submit" class="prefs-btn prefs-ok auth-submit">Log In</button>
        </div>
      </form>
    `

    this.overlay.querySelector('.prefs-cancel')!.addEventListener('click', () => this.close())
    this.overlay.querySelector<HTMLFormElement>('form')!.addEventListener('submit', (e) => {
      e.preventDefault()
      void this.submit()
    })
    this.overlay.querySelectorAll<HTMLButtonElement>('.auth-switch').forEach((button) => {
      button.addEventListener('click', () => {
        this.mode = button.dataset.mode as 'login' | 'register'
        this.updateMode()
      })
    })
    this.overlay.querySelectorAll<HTMLInputElement>('input[name="accountType"]').forEach((input) => {
      input.addEventListener('change', () => {
        this.accountType = input.value as 'personal' | 'company'
        this.updateMode()
      })
    })
    this.updateMode()
  }

  private updateMode(): void {
    const isLogin = this.mode === 'login'
    this.overlay.querySelector<HTMLHeadingElement>('.auth-title')!.textContent = isLogin ? 'Welcome back' : 'Create your account'
    this.overlay.querySelectorAll<HTMLButtonElement>('.auth-switch').forEach((button) => {
      const active = button.dataset.mode === this.mode
      button.classList.toggle('prefs-ok', active)
      button.setAttribute('aria-pressed', String(active))
    })
    this.overlay.querySelector<HTMLInputElement>('#auth-password')!.autocomplete = isLogin ? 'current-password' : 'new-password'
    const confirmRow = this.overlay.querySelector<HTMLDivElement>('.auth-confirm-row')!
    confirmRow.hidden = isLogin
    confirmRow.querySelector('input')!.required = !isLogin
    this.overlay.querySelector<HTMLFieldSetElement>('.auth-account-type')!.hidden = isLogin
    const companyRow = this.overlay.querySelector<HTMLDivElement>('.auth-company-row')!
    companyRow.hidden = isLogin || this.accountType !== 'company'
    companyRow.querySelector('input')!.required = !isLogin && this.accountType === 'company'
    this.overlay.querySelector<HTMLButtonElement>('.auth-submit')!.textContent = isLogin ? 'Log In' : this.accountType === 'company' ? 'Create Company Account' : 'Create Personal Account'
    this.overlay.querySelector<HTMLButtonElement>('.prefs-cancel')!.textContent = 'Cancel'
    this.overlay.querySelector<HTMLDivElement>('.auth-error')!.textContent = ''
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
    const confirmPassword = this.overlay.querySelector<HTMLInputElement>('#auth-confirm-password')?.value ?? ''
    const companyName = this.overlay.querySelector<HTMLInputElement>('#auth-company')?.value.trim() ?? ''
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
    if (this.mode === 'register' && password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    if (this.mode === 'register' && this.accountType === 'company' && (companyName.length < 2 || companyName.length > 100)) {
      setError('Enter a company name between 2 and 100 characters.')
      return
    }

    if (submitBtn) {
      submitBtn.disabled = true
      submitBtn.textContent = 'Please wait…'
    }
    try {
      if (this.mode === 'login') await this.auth.login(email, password)
      else await this.auth.register(email, password, this.accountType === 'company' ? companyName : undefined)
      this.close()
      this.onAuthenticated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      if (submitBtn) {
        submitBtn.disabled = false
        submitBtn.textContent = this.mode === 'login' ? 'Log In' : this.accountType === 'company' ? 'Create Company Account' : 'Create Personal Account'
      }
    }
  }
}
