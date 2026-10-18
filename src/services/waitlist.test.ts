// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WaitlistClient } from './waitlist'

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }))

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('WaitlistClient.join', () => {
  it('POSTs to /api/waitlist with a Bearer header and reports a fresh join', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ joined: true, alreadyJoined: false, createdAt: '2026-10-18T00:00:00Z' }))
    const client = new WaitlistClient('/api/waitlist', () => 'tok-123')
    const result = await client.join('render-credits')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/waitlist')
    expect(init!.method).toBe('POST')
    expect((init!.headers as Headers).get('Authorization')).toBe('Bearer tok-123')
    expect(JSON.parse(init!.body as string)).toEqual({ source: 'render-credits' })
    expect(result).toEqual({ joined: true, alreadyJoined: false, createdAt: '2026-10-18T00:00:00Z' })
  })

  it('maps alreadyJoined from the response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ joined: true, alreadyJoined: true }))
    const result = await new WaitlistClient('/api/waitlist', () => 'tok').join()
    expect(result).toEqual({ joined: true, alreadyJoined: true })
  })

  it('omits the Authorization header when signed out', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ joined: true, alreadyJoined: false }))
    await new WaitlistClient('/api/waitlist', () => null).join()
    const [, init] = fetchMock.mock.calls[0]!
    expect(new Headers(init!.headers).has('Authorization')).toBe(false)
  })

  it('throws on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }))
    await expect(new WaitlistClient('/api/waitlist', () => 'tok').join()).rejects.toThrow('waitlist join failed (401)')
  })
})
