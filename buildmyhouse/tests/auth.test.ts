import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpAuth } from '../src/services/auth'

const SESSION_KEY = 'homely-auth-session'

function makeLocalStorage() {
  const data: Record<string, string> = {}
  return {
    getItem: vi.fn((k: string) => data[k] ?? null),
    setItem: vi.fn((k: string, v: string) => { data[k] = v }),
    removeItem: vi.fn((k: string) => { delete data[k] }),
    clear: vi.fn(() => { for (const k of Object.keys(data)) delete data[k] }),
    data,
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const fetchStub = vi.fn()
let ls: ReturnType<typeof makeLocalStorage>

beforeEach(() => {
  ls = makeLocalStorage()
  Object.defineProperty(globalThis, 'localStorage', { value: ls, writable: true, configurable: true })
  fetchStub.mockReset()
  vi.stubGlobal('fetch', fetchStub)
})

afterEach(() => {
  vi.stubGlobal('fetch', undefined)
})

describe('HttpAuth', () => {
  it('starts signed out with no session', () => {
    const auth = new HttpAuth()
    expect(auth.currentUser()).toBeNull()
    expect(auth.getToken()).toBeNull()
  })

  it('register() POSTs credentials and persists a normalized session', async () => {
    fetchStub.mockResolvedValue(jsonResponse(201, { token: 'jwt' }))
    const auth = new HttpAuth()

    await auth.register(' User@Example.COM ', 'password123')

    expect(fetchStub).toHaveBeenCalledWith('/api/auth/register', expect.objectContaining({ method: 'POST' }))
    expect(auth.currentUser()).toBe('user@example.com')
    expect(auth.getToken()).toBe('jwt')
    expect(JSON.parse(ls.data[SESSION_KEY]!).email).toBe('user@example.com')
  })

  it('login() POSTs to the login endpoint', async () => {
    fetchStub.mockResolvedValue(jsonResponse(200, { token: 'jwt' }))
    const auth = new HttpAuth()

    await auth.login('a@b.co', 'password123')

    expect(fetchStub).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' }))
    expect(auth.currentUser()).toBe('a@b.co')
  })

  it('surfaces server error messages', async () => {
    fetchStub.mockResolvedValue(jsonResponse(401, { error: 'invalid email or password' }))
    const auth = new HttpAuth()

    await expect(auth.login('a@b.co', 'wrongpass1')).rejects.toThrow('invalid email or password')
    expect(auth.currentUser()).toBeNull()
  })

  it('throws a clear error when a non-JSON error body is returned', async () => {
    fetchStub.mockResolvedValue(new Response('oops', { status: 500 }))
    const auth = new HttpAuth()

    await expect(auth.login('a@b.co', 'password123')).rejects.toThrow(/authentication failed \(500\)/)
  })

  it('logout() clears the session', async () => {
    fetchStub.mockResolvedValue(jsonResponse(200, { token: 'jwt' }))
    const auth = new HttpAuth()
    await auth.login('a@b.co', 'password123')

    auth.logout()

    expect(auth.currentUser()).toBeNull()
    expect(auth.getToken()).toBeNull()
    expect(ls.removeItem).toHaveBeenCalledWith(SESSION_KEY)
  })

  it('restores the session from localStorage on construction', () => {
    ls.data[SESSION_KEY] = JSON.stringify({ token: 'jwt', email: 'a@b.co' })
    const auth = new HttpAuth()
    expect(auth.currentUser()).toBe('a@b.co')
    expect(auth.getToken()).toBe('jwt')
  })

  it('ignores a malformed stored session', () => {
    ls.data[SESSION_KEY] = '{bad json'
    const auth = new HttpAuth()
    expect(auth.currentUser()).toBeNull()
  })
})
