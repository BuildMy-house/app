// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HttpAuth } from './auth'

const SESSION_KEY = 'homely-auth-session'
const realLocation = window.location

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }))

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  Object.defineProperty(window, 'location', { value: realLocation, configurable: true, writable: true })
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('googleAvailable', () => {
  it('is true only when the server reports google: true', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ google: true }))
    await expect(new HttpAuth().googleAvailable()).resolves.toBe(true)

    fetchMock.mockResolvedValueOnce(jsonResponse({ google: false }))
    await expect(new HttpAuth().googleAvailable()).resolves.toBe(false)
  })

  it('is false on a non-ok response and never throws on a network error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }))
    await expect(new HttpAuth().googleAvailable()).resolves.toBe(false)

    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(new HttpAuth().googleAvailable()).resolves.toBe(false)
  })
})

describe('startGoogleSignIn', () => {
  it('navigates to /auth/google/start with an encoded returnTo', () => {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { assign, pathname: '/', search: '?waitlist=1', hash: '' },
      configurable: true,
      writable: true,
    })
    new HttpAuth().startGoogleSignIn('/?waitlist=1')
    expect(assign).toHaveBeenCalledWith(`/auth/google/start?returnTo=${encodeURIComponent('/?waitlist=1')}`)
  })

  it('defaults returnTo to the current path and query', () => {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { assign, pathname: '/editor', search: '?x=1', hash: '' },
      configurable: true,
      writable: true,
    })
    new HttpAuth().startGoogleSignIn()
    expect(assign).toHaveBeenCalledWith(`/auth/google/start?returnTo=${encodeURIComponent('/editor?x=1')}`)
  })
})

describe('restoreSession', () => {
  it('returns true immediately when a session is already stored, without fetching', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: 'stored-token', email: 'a@b.com' }))
    const auth = new HttpAuth()
    await expect(auth.restoreSession()).resolves.toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(auth.getToken()).toBe('stored-token')
  })

  it('exchanges the cookie session for a token and stores it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ token: 'cookie-token', user: { id: 'u1', email: 'ada@example.com', name: 'Ada', picture: null } }))
    const auth = new HttpAuth()
    await expect(auth.restoreSession()).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { method: 'POST', credentials: 'same-origin' })
    expect(auth.getToken()).toBe('cookie-token')
    expect(auth.currentUser()).toBe('ada@example.com')
    expect(JSON.parse(localStorage.getItem(SESSION_KEY)!)).toEqual({ token: 'cookie-token', email: 'ada@example.com' })
  })

  it('returns false on 401 without storing anything', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))
    const auth = new HttpAuth()
    await expect(auth.restoreSession()).resolves.toBe(false)
    expect(auth.getToken()).toBeNull()
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('returns false on a network error and never throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(new HttpAuth().restoreSession()).resolves.toBe(false)
  })
})

describe('logout', () => {
  it('clears the local session synchronously and fires a best-effort server logout', () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: 't', email: 'a@b.com' }))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const auth = new HttpAuth()
    const result = auth.logout()
    expect(result).toBeUndefined()
    expect(auth.getToken()).toBeNull()
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' })
  })

  it('does not throw when the logout request fails', () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect(() => new HttpAuth().logout()).not.toThrow()
  })
})
