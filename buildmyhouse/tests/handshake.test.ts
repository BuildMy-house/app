import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  AutomationClient,
  automationPortFromEnv,
  automationPortFromSearch,
} from '../src/automation/client'
import { HomelyCommandHandler } from '../src/automation/homely-handler'
import { createEmptyHome } from '../src/core/home'
import { HomeStore } from '../src/core/store'
import type { NormalizedHomeState } from '../src/core/home'
import { MockOrchestrator } from '../src/dev/mock-orchestrator'

let orch: MockOrchestrator
let store: HomeStore
let client: AutomationClient

beforeAll(async () => {
  orch = new MockOrchestrator()
  const port = await orch.start()
  // Fixed zone: compass defaults must not depend on the machine timezone.
  store = new HomeStore('Asia/Thimphu')
  client = new AutomationClient(new HomelyCommandHandler(store), {
    port,
    mode: 'test',
  })
})

afterAll(async () => {
  client.close()
  await orch.close()
})

async function awaitHello(): Promise<void> {
  await vi.waitFor(
    () => {
      if (!orch.hello) throw new Error('no hello yet')
    },
    { timeout: 2000, interval: 20 },
  )
}

describe('ws protocol v1 handshake', () => {
  it('sends hello as the first message', async () => {
    await awaitHello()
    expect(orch.hello).toEqual({
      type: 'hello',
      app: 'homely',
      version: 1,
      mode: 'test',
    })
    expect(orch.unexpected).toEqual([])
  })

  it('answers ping with pong', async () => {
    await awaitHello()
    const res = await orch.sendRequest('ping')
    expect(res).toMatchObject({ ok: true, data: { pong: true } })
  })

  it('get_state returns the schema-conformant empty home', async () => {
    await awaitHello()
    const res = await orch.sendRequest('get_state')
    expect(res.ok).toBe(true)
    const home = res.data as NormalizedHomeState
    // Required top-level keys per docs/schema/home-project.schema.json v1
    expect(Object.keys(home)).toEqual(
      expect.arrayContaining([
        'schemaVersion',
        'levels',
        'walls',
        'rooms',
        'furniture',
        'dimensionLines',
        'labels',
        'selection',
        'cameras',
        'capabilities',
      ]),
    )
    expect(home.schemaVersion).toBe(1)
    // SH3D 7.5 empty-home ground truth (driver golden create_room.expected-state.json)
    expect(home.levels).toEqual([])
    expect(home.cameras.top).toEqual({
      id: 'camera-top-1',
      x: 50,
      y: 1050,
      z: 1010,
      // yaw pi exports wrapped to -180 (docs/behaviours §2)
      yawDeg: -180,
      pitchDeg: 45,
      fovDeg: 63,
      lens: 'PINHOLE',
    })
    expect(home.cameras.observer).toEqual({
      id: 'camera-observer-1',
      x: 50,
      y: 50,
      z: 170,
      // SH3D stores 315°; wire export wraps into [-180, 180)
      yawDeg: -45,
      pitchDeg: 11.25,
      fovDeg: 63,
      lens: 'PINHOLE',
      fixedSize: false,
    })
    expect(home.compass).toEqual({
      x: -100,
      y: 50,
      diameter: 100,
      northDirectionDeg: 0,
      // Asia/Thimphu per Compass.java table, exported round3
      latitudeRad: 0.48,
      longitudeRad: 1.564,
      visible: true,
    })
    expect(home.environment).toEqual({
      skyColor: 0xcce4fc,
      groundColor: 0xa8a8a8,
      lightColor: 0xd0d0d0,
      wallsAlpha: 0,
    })
    expect(home.capabilities).toEqual({ canUndo: false, canRedo: false })
  })

  it('new_home resets state and clears undo stack', async () => {
    await awaitHello()
    const res = await orch.sendRequest('new_home')
    expect(res).toMatchObject({ ok: true, data: {} })
    expect(store.getHome()).toEqual(createEmptyHome('Asia/Thimphu'))
    expect(store.canUndo()).toBe(false)
  })

  it('reports implemented commands via get_capabilities', async () => {
    await awaitHello()
    const res = await orch.sendRequest('get_capabilities')
    expect(res).toMatchObject({
      ok: true,
      data: {
        commands: expect.arrayContaining([
          'ping',
          'new_home',
          'get_state',
          'get_capabilities',
          'add_furniture',
          'undo',
          'redo',
          'set_camera',
          'camera_preset',
          'select_tool',
          'click',
          'drag',
          'key',
          'set_magnetism',
          'screenshot',
        ]),
      },
    })
  })

  it('rejects unknown commands with a code', async () => {
    await awaitHello()
    const res = await orch.sendRequest('no_such_command', { factor: 2 })
    expect(res.ok).toBe(false)
    expect(res.code).toBe('UNKNOWN_COMMAND')
    expect(typeof res.error).toBe('string')
  })

  it('matches responses to ids under concurrent distinct requests', async () => {
    await awaitHello()
    const [r1, r2] = await Promise.all([
      orch.sendRequest('ping'),
      orch.sendRequest('get_capabilities'),
    ])
    expect(r1.id).not.toBe(r2.id)
    const pong = r1.data as { pong?: boolean; commands?: unknown }
    const caps = r2.data as { pong?: boolean; commands?: unknown }
    const byPong = [pong, caps].find((d) => d.pong === true)
    const byCaps = [pong, caps].find((d) => Array.isArray(d.commands))
    expect(byPong).toBeDefined()
    expect(byCaps).toBeDefined()
  })

  it('ignores malformed frames and still answers the next request', async () => {
    await awaitHello()
    orch.sendRaw('')
    orch.sendRaw('this is not json')
    orch.sendRaw('42')
    orch.sendRaw('[1,2,3]')
    orch.sendRaw('"just a string"')
    orch.sendRaw('\n\n')
    const res = await orch.sendRequest('ping')
    expect(res.ok).toBe(true)
    expect(orch.unexpected).toEqual([])
  })

  it('answers INVALID_REQUEST for envelopes with a string id but bad type', async () => {
    await awaitHello()
    const pending = orch.awaitResponseFor('bad-1')
    orch.sendRaw(JSON.stringify({ id: 'bad-1', type: 5 }))
    const res = await pending
    expect(res.id).toBe('bad-1')
    expect(res.ok).toBe(false)
    expect(res.code).toBe('INVALID_REQUEST')
  })

  it('silently drops envelopes without a string id', async () => {
    await awaitHello()
    orch.sendRaw(JSON.stringify({ id: 42, type: 'ping' }))
    orch.sendRaw(JSON.stringify({ type: 'ping' }))
    const res = await orch.sendRequest('ping')
    expect(res.ok).toBe(true)
    expect(orch.unexpected).toEqual([])
  })

  it('add_furniture + undo + redo round-trips with capability flags', async () => {
    await awaitHello()
    const added = await orch.sendRequest('add_furniture', {
      name: 'table',
      x: 120.123456,
      y: 80,
      angleDeg: 45,
      width: 100,
      depth: 60,
      height: 75,
      elevation: 2.5,
    })
    expect(added.ok).toBe(true)
    const { id } = added.data as { id: string }
    expect(id).toMatch(/^furniture-/)

    let state = (await orch.sendRequest('get_state')).data as {
      furniture: Array<{ id: string; x: number }>
      capabilities: { canUndo: boolean; canRedo: boolean }
    }
    expect(state.furniture).toHaveLength(1)
    expect(state.furniture[0]).toMatchObject({ id, x: 120.123 })
    expect(state.capabilities).toEqual({ canUndo: true, canRedo: false })

    const undoRes = (await orch.sendRequest('undo')).data as {
      canUndo: boolean
      canRedo: boolean
    }
    // frozen wire shape is exactly {canUndo,canRedo} (ws-protocol.md)
    expect(undoRes).toEqual({ canUndo: false, canRedo: true })

    const redoRes = (await orch.sendRequest('redo')).data as {
      canUndo: boolean
      canRedo: boolean
    }
    expect(redoRes).toEqual({ canUndo: true, canRedo: false })
    state = (await orch.sendRequest('get_state')).data as typeof state
    expect(state.furniture).toHaveLength(1)

    // invalid params surface as INVALID_PARAMS, not INTERNAL
    await orch
      .sendRequest('add_furniture', { name: 'x', x: 0, y: 0, angleDeg: 0, width: -1, depth: 1, height: 1 })
      .then((res) => {
        expect(res.ok).toBe(false)
        expect(res.code).toBe('INVALID_PARAMS')
      })

    // non-string name is rejected (no silent coercion)
    await orch
      .sendRequest('add_furniture', { name: 123, x: 0, y: 0, width: 1, depth: 1, height: 1 })
      .then((res) => {
        expect(res.ok).toBe(false)
        expect(res.code).toBe('INVALID_PARAMS')
      })

    // catalogId passes through to the created object when dimensions are inline
    const cat = await orch.sendRequest('add_furniture', {
      catalogId: 'sample-123',
      name: 'chair',
      x: 10,
      y: 10,
      width: 20,
      depth: 20,
      height: 40,
    })
    expect(cat.ok).toBe(true)
    const catState = (await orch.sendRequest('get_state')).data as {
      furniture: Array<{ catalogId: string | null }>
    }
    expect(catState.furniture.at(-1)?.catalogId).toBe('sample-123')

    // new_home still clears history
    await orch.sendRequest('new_home')
    state = (await orch.sendRequest('get_state')).data as typeof state
    expect(state.capabilities).toEqual({ canUndo: false, canRedo: false })
    expect(state.furniture).toEqual([])
  })
})

describe('port seams', () => {
  it('parses HOMELY_AUTOMATION_PORT', () => {
    expect(automationPortFromEnv({ HOMELY_AUTOMATION_PORT: '8765' })).toBe(8765)
    expect(automationPortFromEnv({})).toBeNull()
    expect(automationPortFromEnv({ HOMELY_AUTOMATION_PORT: 'nope' })).toBeNull()
    expect(automationPortFromEnv({ HOMELY_AUTOMATION_PORT: '-1' })).toBeNull()
  })

  it('rejects non-canonical numeric port strings', () => {
    expect(automationPortFromEnv({ HOMELY_AUTOMATION_PORT: '0x10' })).toBeNull()
    expect(automationPortFromEnv({ HOMELY_AUTOMATION_PORT: '+8765' })).toBeNull()
    expect(automationPortFromEnv({ HOMELY_AUTOMATION_PORT: ' 8765' })).toBeNull()
    expect(automationPortFromSearch('?automationPort=0x10')).toBeNull()
    expect(automationPortFromSearch('?automationPort=%208765')).toBeNull()
    expect(automationPortFromSearch('?automationPort=1.5')).toBeNull()
    expect(automationPortFromSearch('?automationPort=65536')).toBeNull()
  })

  it('parses ?automationPort=', () => {
    expect(automationPortFromSearch('?automationPort=1234&x=1')).toBe(1234)
    expect(automationPortFromSearch('?x=1')).toBeNull()
    expect(automationPortFromSearch('?automationPort=abc')).toBeNull()
  })
})
