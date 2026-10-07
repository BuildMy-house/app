// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetAnalyticsForTests, flush, initAnalytics, submitFeedback, track, trackOnce } from './analytics'

const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 202 }))

function sentEvents(): Array<{ sid: string; aid: string; events: Array<{ name: string; props?: Record<string, unknown> }> }> {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).endsWith('/events'))
    .map((c) => JSON.parse((c[1] as RequestInit).body as string))
}

beforeEach(() => {
  _resetAnalyticsForTests()
  localStorage.clear()
  sessionStorage.clear()
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true })
})
afterEach(() => vi.unstubAllGlobals())

describe('analytics client', () => {
  it('sends session_start + pageview with anonymous ids only', () => {
    initAnalytics()
    flush()
    const [body] = sentEvents() as [ReturnType<typeof sentEvents>[number]]
    expect(body.events.map((e) => e.name)).toEqual(['session_start', 'pageview'])
    expect(body.sid).toMatch(/^[a-f0-9]{32}$/)
    expect(body.aid).toMatch(/^[a-f0-9]{32}$/)
    expect(body.sid).not.toBe(body.aid)
  })

  it('reuses the session on reload (no second session_start) and keeps the device id', () => {
    initAnalytics()
    const first = localStorage.getItem('bmh-aid')
    _resetAnalyticsForTests()
    fetchMock.mockClear()
    initAnalytics()
    flush()
    expect(sentEvents()[0]!.events.map((e) => e.name)).toEqual(['pageview'])
    expect(localStorage.getItem('bmh-aid')).toBe(first)
  })

  it('trackOnce fires a milestone once per session', () => {
    initAnalytics()
    trackOnce('first_3d_view_opened', { via: 'split' })
    trackOnce('first_3d_view_opened', { via: 'interact' })
    track('plan_exported', { kind: 'print' })
    flush()
    const names = sentEvents().flatMap((b) => b.events.map((e) => e.name))
    expect(names.filter((n) => n === 'first_3d_view_opened')).toHaveLength(1)
    expect(names).toContain('plan_exported')
  })

  it('sends nothing when Do Not Track is set', () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true })
    initAnalytics()
    track('plan_saved')
    flush()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('submits feedback with session id and plan state', async () => {
    initAnalytics()
    expect(await submitFeedback('hello', '', { walls: 3, furniture: 1 })).toBe(true)
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/feedback'))!
    const body = JSON.parse((call[1] as RequestInit).body as string)
    expect(body).toMatchObject({ message: 'hello', state: { walls: 3, furniture: 1 } })
    expect(body.sid).toMatch(/^[a-f0-9]{32}$/)
  })
})
