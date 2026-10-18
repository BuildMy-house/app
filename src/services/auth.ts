/**
 * Auth seam for the Track H server backend (/api/auth/*).
 *
 * The server signs a JWT whose `sub` is the user's UUID — the email is never
 * returned in any response. We therefore persist { token, email } together in
 * localStorage: the token drives Authorization headers, the email drives the
 * signed-in display. Email is normalized client-side the same way the server
 * does (trim + lowercase) so the stored value matches what the user typed in
 * a canonical, display-safe form.
 */

const SESSION_KEY = 'homely-auth-session'

interface Session {
  token: string
  email: string
}

export interface AuthAdapter {
  /** Currently signed-in user's email, or null when signed out. */
  currentUser(): string | null
  /** Raw JWT for Authorization headers, or null when signed out. */
  getToken(): string | null
  login(email: string, password: string): Promise<void>
  register(email: string, password: string, companyName?: string): Promise<void>
  changePassword(currentPassword: string, newPassword: string): Promise<void>
  logout(): void
  /** Whether the server has Google sign-in configured. False on any failure. */
  googleAvailable(): Promise<boolean>
  /** Full-page redirect into the server's Google OAuth flow. */
  startGoogleSignIn(returnTo?: string): void
  /**
   * Resolve the current session. Returns true when already signed in locally,
   * otherwise exchanges the server's httpOnly cookie for a bearer token and
   * stores it. Never throws: any failure (401, network error) returns false.
   */
  restoreSession(): Promise<boolean>
}

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Session>
    if (typeof parsed?.token === 'string' && parsed.token) {
      return { token: parsed.token, email: typeof parsed.email === 'string' ? parsed.email : '' }
    }
    return null
  } catch {
    return null
  }
}

export class HttpAuth implements AuthAdapter {
  private session: Session | null = readSession()

  currentUser(): string | null {
    return this.session?.email ?? null
  }

  getToken(): string | null {
    return this.session?.token ?? null
  }

  private setSession(session: Session): void {
    this.session = session
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  }

  private async post(path: string, email: string, password: string, extra: Record<string, string> = {}): Promise<void> {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, ...extra }),
    })
    if (!response.ok) {
      let message = `authentication failed (${response.status})`
      try {
        const data = (await response.json()) as { error?: unknown }
        if (typeof data.error === 'string' && data.error) message = data.error
      } catch {
        // non-JSON error body; keep the generic message
      }
      throw new Error(message)
    }
    const data = (await response.json()) as { token?: unknown }
    if (typeof data.token !== 'string' || !data.token) {
      throw new Error('authentication succeeded but no token was returned')
    }
    this.setSession({ token: data.token, email: email.trim().toLowerCase() })
  }

  async login(email: string, password: string): Promise<void> {
    await this.post('/api/auth/login', email, password)
  }

  async register(email: string, password: string, companyName?: string): Promise<void> {
    await this.post('/api/auth/register', email, password, companyName ? { companyName } : {})
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const token = this.getToken()
    if (!token) throw new Error('not signed in')
    const response = await fetch('/api/auth/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ currentPassword, newPassword }),
    })
    if (!response.ok) {
      let message = `change password failed (${response.status})`
      try {
        const data = (await response.json()) as { error?: unknown }
        if (typeof data.error === 'string' && data.error) message = data.error
      } catch { /* non-JSON */ }
      throw new Error(message)
    }
  }

  async googleAvailable(): Promise<boolean> {
    try {
      const response = await fetch('/api/auth/providers')
      if (!response.ok) return false
      const data = (await response.json()) as { google?: unknown }
      return data.google === true
    } catch {
      return false
    }
  }

  startGoogleSignIn(returnTo?: string): void {
    const target = returnTo ?? `${window.location.pathname}${window.location.search}`
    window.location.assign(`/auth/google/start?returnTo=${encodeURIComponent(target)}`)
  }

  async restoreSession(): Promise<boolean> {
    if (this.session) return true
    try {
      const response = await fetch('/api/auth/session', {
        method: 'POST',
        credentials: 'same-origin',
      })
      if (!response.ok) return false
      const data = (await response.json()) as { token?: unknown; user?: { email?: unknown } }
      if (typeof data.token !== 'string' || !data.token) return false
      const email = typeof data.user?.email === 'string' ? data.user.email.trim().toLowerCase() : ''
      this.setSession({ token: data.token, email })
      return true
    } catch {
      return false
    }
  }

  logout(): void {
    this.session = null
    localStorage.removeItem(SESSION_KEY)
    // Fire-and-forget: clear the server's httpOnly cookie session too. Kept
    // synchronous so existing call sites need no await.
    void fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
  }
}
