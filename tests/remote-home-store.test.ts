import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomeStore } from '../src/core/store'
import { AuthRequiredError, RemoteHomeStore } from '../src/services/adapters/remote-home-store'
import { serializeForSave } from '../src/services/adapters/home-persistence'

function sampleHome() {
  const store = new HomeStore()
  return store.getHome()
}

/** Wrap a fetch stub that returns a JSON body with the given status. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const fetchStub = vi.fn()

afterEach(() => {
  fetchStub.mockReset()
  vi.stubGlobal('fetch', undefined)
})

describe('RemoteHomeStore.list()', () => {
  it('returns the summary items from the server', async () => {
    const items = [
      { id: 'h1', name: 'House A', createdAt: 't1', updatedAt: 't2' },
      { id: 'h2', name: 'House B', createdAt: 't3', updatedAt: 't4' },
    ]
    fetchStub.mockResolvedValue(jsonResponse(200, { items }))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore()
    const result = await store.list()

    expect(result).toEqual(items)
    expect(fetchStub).toHaveBeenCalledWith('/api/homes')
  })

  it('throws when the server is unavailable', async () => {
    fetchStub.mockResolvedValue(jsonResponse(500, { error: 'boom' }))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore()
    await expect(store.list()).rejects.toThrow(/unavailable/)
  })
})

describe('RemoteHomeStore.save()', () => {
  it('POSTs a serialized home to create a new one when no id is given', async () => {
    const home = sampleHome()
    const record = { id: 'h1', name: 'House A', json: serializeForSave(home), createdAt: 't', updatedAt: 't' }
    fetchStub.mockResolvedValue(jsonResponse(201, record))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore()
    const result = await store.save(home, { name: 'House A' })

    expect(result).toEqual(record)
    expect(fetchStub).toHaveBeenCalledTimes(1)
    const [url, init] = fetchStub.mock.calls[0]!
    expect(url).toBe('/api/homes')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.name).toBe('House A')
    expect(JSON.parse(body.json).schemaVersion).toBe(1)
  })

  it('PUTs to update the home when an id is given', async () => {
    const home = sampleHome()
    const record = { id: 'h1', name: 'House A', json: serializeForSave(home), createdAt: 't', updatedAt: 't' }
    fetchStub.mockResolvedValue(jsonResponse(200, record))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore()
    await store.save(home, { id: 'h1', name: 'House A' })

    const [url, init] = fetchStub.mock.calls[0]!
    expect(url).toBe('/api/homes/h1')
    expect(init.method).toBe('PUT')
  })

  it('throws when save fails', async () => {
    fetchStub.mockResolvedValue(jsonResponse(400, { error: 'bad' }))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore()
    await expect(store.save(sampleHome())).rejects.toThrow(/save failed/)
  })
})

describe('RemoteHomeStore.load()', () => {
  it('parses the stored JSON back into a home', async () => {
    const home = sampleHome()
    const record = { id: 'h1', name: 'House A', json: serializeForSave(home), createdAt: 't', updatedAt: 't' }
    fetchStub.mockResolvedValue(jsonResponse(200, record))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore()
    const loaded = await store.load('h1')

    expect(loaded.walls).toEqual(home.walls)
    expect(loaded.schemaVersion).toBe(1)
    expect(fetchStub).toHaveBeenCalledWith('/api/homes/h1')
  })

  it('throws on a parse failure', async () => {
    const record = { id: 'h1', name: 'House A', json: '{not valid json', createdAt: 't', updatedAt: 't' }
    fetchStub.mockResolvedValue(jsonResponse(200, record))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore()
    await expect(store.load('h1')).rejects.toThrow()
  })
})

describe('RemoteHomeStore.remove()', () => {
  it('DELETEs the home by id', async () => {
    fetchStub.mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore()
    await store.remove('h1')

    const [url, init] = fetchStub.mock.calls[0]!
    expect(url).toBe('/api/homes/h1')
    expect(init.method).toBe('DELETE')
  })

  it('throws when removal fails', async () => {
    fetchStub.mockResolvedValue(jsonResponse(404, { error: 'not found' }))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore()
    await expect(store.remove('h1')).rejects.toThrow(/removal failed/)
  })
})

describe('RemoteHomeStore Authorization header', () => {
  it('adds a Bearer token to list() when a token is available', async () => {
    fetchStub.mockResolvedValue(jsonResponse(200, { items: [] }))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore('/api/homes', () => 'tok-123')
    await store.list()

    const [url, init] = fetchStub.mock.calls[0]!
    expect(url).toBe('/api/homes')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok-123')
  })

  it('merges Authorization with Content-Type on save()', async () => {
    const home = sampleHome()
    const record = { id: 'h1', name: 'House A', json: serializeForSave(home), createdAt: 't', updatedAt: 't' }
    fetchStub.mockResolvedValue(jsonResponse(201, record))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore('/api/homes', () => 'tok-123')
    await store.save(home, { name: 'House A' })

    const [, init] = fetchStub.mock.calls[0]!
    const headers = new Headers(init.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Authorization')).toBe('Bearer tok-123')
  })

  it('adds a Bearer token to load() without disturbing single-arg parity', async () => {
    const home = sampleHome()
    const record = { id: 'h1', name: 'House A', json: serializeForSave(home), createdAt: 't', updatedAt: 't' }
    fetchStub.mockResolvedValue(jsonResponse(200, record))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore('/api/homes', () => 'tok-123')
    await store.load('h1')

    const [url, init] = fetchStub.mock.calls[0]!
    expect(url).toBe('/api/homes/h1')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok-123')
  })
})

/** Resolve to the rejection value (or fail the test if the promise resolved). */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected the promise to reject')
}

describe('RemoteHomeStore 401 handling', () => {
  it('classifies a 401 save as AuthRequiredError and keeps the legacy message shape', async () => {
    fetchStub.mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore()
    const err = await rejection(store.save(sampleHome(), { name: 'House A' }))

    expect(err).toBeInstanceOf(AuthRequiredError)
    expect((err as Error).message).toMatch(/^home save failed \(401\)/)
    expect((err as Error).message).toMatch(/sign in again/)
  })

  it('classifies 401 on list(), loadRecord(), and remove() as AuthRequiredError', async () => {
    fetchStub.mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore()
    await expect(store.list()).rejects.toBeInstanceOf(AuthRequiredError)
    await expect(store.loadRecord('h1')).rejects.toBeInstanceOf(AuthRequiredError)
    await expect(store.remove('h1')).rejects.toBeInstanceOf(AuthRequiredError)
  })

  it('classifies a 401 on the first leg of rename() as AuthRequiredError', async () => {
    fetchStub.mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore()
    await expect(store.rename('h1', 'New name')).rejects.toBeInstanceOf(AuthRequiredError)
  })

  it('still throws a plain Error with the original message for non-401 failures', async () => {
    fetchStub.mockResolvedValue(jsonResponse(500, { error: 'boom' }))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore()
    const listErr = await rejection(store.list())
    expect(listErr).not.toBeInstanceOf(AuthRequiredError)
    expect(listErr).toBeInstanceOf(Error)
    expect((listErr as Error).message).toBe('home library unavailable (500)')

    fetchStub.mockResolvedValue(jsonResponse(400, { error: 'bad' }))
    const saveErr = await rejection(store.save(sampleHome(), { name: 'House A' }))
    expect(saveErr).not.toBeInstanceOf(AuthRequiredError)
    expect((saveErr as Error).message).toBe('home save failed (400)')
  })

  it('classifies 401 on subscribe() and setPresence() as AuthRequiredError', async () => {
    fetchStub.mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }))
    vi.stubGlobal('fetch', fetchStub)

    const store = new RemoteHomeStore()
    await expect(store.subscribe('h1', () => {})).rejects.toBeInstanceOf(AuthRequiredError)
    await expect(store.setPresence('h1')).rejects.toBeInstanceOf(AuthRequiredError)
  })
})
