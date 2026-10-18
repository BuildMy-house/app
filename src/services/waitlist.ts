/**
 * Render-credits waitlist client (/api/waitlist/*). Bearer-authenticated with
 * the same JWT the rest of the account API uses — joining requires sign-in.
 */

/** Outcome of a join request. `alreadyJoined` distinguishes a repeat join. */
export interface WaitlistJoinResult {
  joined: true
  alreadyJoined: boolean
  createdAt?: string
}

export class WaitlistClient {
  constructor(
    private readonly baseUrl = '/api/waitlist',
    private readonly getToken: () => string | null = () => null,
  ) {}

  private async request(url: string, init?: RequestInit): Promise<Response> {
    const token = this.getToken()
    if (!token) return init ? fetch(url, init) : fetch(url)
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)
    return fetch(url, { ...init, headers })
  }

  /** Join the waitlist. Idempotent server-side; repeat joins set alreadyJoined. */
  async join(source?: string): Promise<WaitlistJoinResult> {
    const response = await this.request(this.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(source ? { source } : {}),
    })
    if (!response.ok) throw new Error(`waitlist join failed (${response.status})`)
    const data = (await response.json()) as { alreadyJoined?: unknown; createdAt?: unknown }
    return {
      joined: true,
      alreadyJoined: data.alreadyJoined === true,
      ...(typeof data.createdAt === 'string' ? { createdAt: data.createdAt } : {}),
    }
  }
}
