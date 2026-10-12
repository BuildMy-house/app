import { describe, expect, it } from 'vitest'
import { HomelyCommandHandler } from '../src/automation/homely-handler'
import { HomeStore } from '../src/core/store'

function setup() {
  const store = new HomeStore('Asia/Thimphu')
  const handler = new HomelyCommandHandler(store)
  const run = (type: string, params: Record<string, unknown> = {}) => {
    const res = handler.execute(type, params)
    if (!res.ok) throw new Error(`${type}: ${res.code} ${res.error}`)
    return res.data as Record<string, unknown>
  }
  const room = () => {
    const pts: Array<[number, number]> = [[0, 0], [400, 0], [400, 400], [0, 400]]
    pts.forEach(([xs, ys], i) => {
      const [xe, ye] = pts[(i + 1) % 4]!
      run('add_wall', { xStart: xs, yStart: ys, xEnd: xe, yEnd: ye, thickness: 10 })
    })
    run('add_room', { points: pts, name: 'Living' })
  }
  const snapshot = () => JSON.stringify({ home: store.getHome(), canUndo: store.canUndo(), canRedo: store.canRedo(), dirty: store.isDirty() })
  return { store, handler, run, room, snapshot }
}

const sofa = (width: number) => ({ name: 'Sofa', x: 200, y: 200, width, depth: 90, height: 80 })

describe('begin_batch / end_batch (MCP build_house is all-or-nothing)', () => {
  it('rolls back a whole build, including the reset, when a piece is too large', () => {
    const { store, handler, run, room, snapshot } = setup()
    room()
    run('add_furniture', sofa(200))
    const before = snapshot()

    run('begin_batch')
    run('new_home')
    room()
    const rejected = handler.execute('add_furniture', sofa(500))
    expect(rejected).toMatchObject({ ok: false, code: 'FURNITURE_TOO_LARGE' })
    run('end_batch', { commit: false })

    expect(snapshot()).toBe(before)
    // The id counter is restored too: a rolled-back build must not burn or reuse ids.
    expect(store.generateId('next')).toBe('next-7')
  })

  it('commit keeps the build and its undo history', () => {
    const { store, run, room } = setup()
    run('begin_batch')
    room()
    run('add_furniture', sofa(200))
    run('end_batch', { commit: true })
    expect(store.getHome().furniture).toHaveLength(1)
    expect(store.canUndo()).toBe(true)
    run('end_batch', { commit: false })
    expect(store.getHome().furniture).toHaveLength(1)
  })

  it('a batch whose caller vanished is rolled back when the next one starts', () => {
    const { store, run, room } = setup()
    room()
    run('begin_batch')
    run('add_furniture', sofa(200))
    run('begin_batch')
    expect(store.getHome().furniture).toHaveLength(0)
    run('end_batch', { commit: true })
  })

  it('a document opened by the user mid-batch is not clobbered by the batch rollback', () => {
    const { store, run, room } = setup()
    room()
    const saved = run('save').json
    run('begin_batch')
    run('add_furniture', sofa(200))
    run('open', { json: saved })
    run('end_batch', { commit: false })
    expect(store.getHome().walls).toHaveLength(4)
    expect(store.getHome().furniture).toHaveLength(0)
  })

  it('end_batch requires a boolean commit', () => {
    const { handler } = setup()
    expect(handler.execute('end_batch', {})).toMatchObject({ ok: false, code: 'INVALID_PARAMS' })
  })
})

describe('open reports furniture that clips walls in the loaded file', () => {
  it('lists overlaps and oversize pieces, and still loads the file verbatim', () => {
    const { store, run, room } = setup()
    room()
    const id = (run('add_furniture', sofa(200)) as { id: string }).id
    const home = store.getHome()
    home.furniture[0]!.y = 0
    const data = run('open', { json: home }) as { clearance: { overlaps: Array<{ furnitureId: string }>; oversize: unknown[] } }
    expect(data.clearance.overlaps.map((o) => o.furnitureId)).toEqual([id])
    expect(data.clearance.oversize).toEqual([])
    expect(store.peek().furniture[0]!.y).toBe(0)
  })
})
