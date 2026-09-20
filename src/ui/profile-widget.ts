import type { AuthAdapter } from '../services/auth'

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

export interface ProfileWidgetActions {
  onSignUp: () => void
  onLogIn: () => void
  onLogOut: () => void
  onChangePassword: () => void
  onManageProjects: () => void
}

/**
 * Always-visible top-right account control. Signed out: a "Sign Up to Save"
 * nudge, since the local draft (local-draft.ts) already keeps the current
 * design across a refresh — the nudge is about the cloud library
 * (multi-project, cross-device), not about losing work. Signed in: an avatar
 * (initial letter) + email, with a dropdown for account actions.
 */
export class ProfileWidget {
  private el: HTMLDivElement
  private auth: AuthAdapter
  private actions: ProfileWidgetActions
  private open = false

  constructor(host: HTMLElement, auth: AuthAdapter, actions: ProfileWidgetActions) {
    this.auth = auth
    this.actions = actions
    this.el = document.createElement('div')
    this.el.id = 'profile-widget'
    host.appendChild(this.el)
    document.addEventListener('click', (e) => {
      if (this.open && !this.el.contains(e.target as Node)) this.setOpen(false)
    })
    this.render()
  }

  refresh(): void {
    this.render()
  }

  private setOpen(next: boolean): void {
    this.open = next
    this.render()
  }

  private render(): void {
    const user = this.auth.currentUser()

    if (!user) {
      this.el.innerHTML = `
        <button type="button" class="profile-signup-btn" title="Create an account to save your projects to the cloud">
          <span class="profile-avatar profile-avatar-guest">?</span>
          Sign Up to Save
        </button>
        <button type="button" class="profile-login-link">Log In</button>
      `
      this.el.querySelector('.profile-signup-btn')!.addEventListener('click', () => this.actions.onSignUp())
      this.el.querySelector('.profile-login-link')!.addEventListener('click', () => this.actions.onLogIn())
      return
    }

    const initial = user.trim().charAt(0).toUpperCase() || '?'
    this.el.innerHTML = `
      <button type="button" class="profile-trigger" aria-expanded="${this.open}">
        <span class="profile-avatar">${escapeHtml(initial)}</span>
        <span class="profile-email">${escapeHtml(user)}</span>
      </button>
      <div class="profile-dropdown" style="display:${this.open ? 'block' : 'none'}">
        <div class="profile-dropdown-header">Signed in as<br /><strong>${escapeHtml(user)}</strong></div>
        <div class="menu-separator"></div>
        <button type="button" class="menu-entry" data-action="projects"><span>My Projects…</span></button>
        <button type="button" class="menu-entry" data-action="password"><span>Change Password…</span></button>
        <div class="menu-separator"></div>
        <button type="button" class="menu-entry" data-action="logout"><span>Log Out</span></button>
      </div>
    `

    this.el.querySelector('.profile-trigger')!.addEventListener('click', (e) => {
      e.stopPropagation()
      this.setOpen(!this.open)
    })
    this.el.querySelector('[data-action="projects"]')!.addEventListener('click', () => {
      this.setOpen(false)
      this.actions.onManageProjects()
    })
    this.el.querySelector('[data-action="password"]')!.addEventListener('click', () => {
      this.setOpen(false)
      this.actions.onChangePassword()
    })
    this.el.querySelector('[data-action="logout"]')!.addEventListener('click', () => {
      this.setOpen(false)
      this.actions.onLogOut()
    })
  }
}
