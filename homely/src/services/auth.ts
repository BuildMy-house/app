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
  register(email: string, password: string): Promise<void>
  logout(): void
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

  private async post(path: string, email: string, password: string): Promise<void> {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
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

  async register(email: string, password: string): Promise<void> {
    await this.post('/api/auth/register', email, password)
  }

  logout(): void {
    this.session = null
    localStorage.removeItem(SESSION_KEY)
  }
}
