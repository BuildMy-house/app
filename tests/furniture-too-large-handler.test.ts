import { describe, expect, it } from 'vitest'
import { HomelyCommandHandler } from '../src/automation/homely-handler'
import { HomeStore } from '../src/core/store'

function roomHome() {
  const store = new HomeStore('Asia/Thimphu')
  const handler = new HomelyCommandHandler(store)
  const pts: Array<[number, number]> = [[0, 0], [400, 0], [400, 400], [0, 400]]
  for (let i = 0; i < 4; i++) {
    const [xs, ys] = pts[i]!
    const [xe, ye] = pts[(i + 1) % 4]!
    handler.execute('add_wall', { xStart: xs, yStart: ys, xEnd: xe, yEnd: ye, thickness: 10 })
  }
  handler.execute('add_room', { points: pts, name: 'Living' })
  return { store, handler }
}

const sofa = (width: number) => ({ name: 'Sofa', x: 200, y: 200, width, depth: 90, height: 80 })

describe('MCP furniture-too-large rejection', () => {
  it('add_furniture returns a structured error and leaves state untouched', () => {
    const { store, handler } = roomHome()
    const undoBefore = store.canUndo()
    const res = handler.execute('add_furniture', sofa(500))
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('FURNITURE_TOO_LARGE')
    expect(res.error).toContain('"Sofa" (500 x 90 cm) is too large for room "Living"')
    expect(res.details).toMatchObject({
      furnitureName: 'Sofa',
      widthCm: 500,
      depthCm: 90,
      roomName: 'Living',
    })
    expect(store.getHome().furniture).toHaveLength(0)
    expect(store.canUndo()).toBe(undoBefore)
  })

  it('add_furniture accepts a piece that fits', () => {
    const { handler } = roomHome()
    expect(handler.execute('add_furniture', sofa(200)).ok).toBe(true)
  })

  it('modify_selected rejects an oversize resize atomically', () => {
    const { store, handler } = roomHome()
    const added = handler.execute('add_furniture', sofa(200))
    if (!added.ok) throw new Error('setup')
    const { id } = added.data as { id: string }
    handler.execute('select_object', { objectId: id })
    const before = JSON.stringify(store.getHome().furniture)
    const res = handler.execute('modify_selected', { props: { width: 600 } })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('FURNITURE_TOO_LARGE')
    expect(res.details).toMatchObject({ furnitureName: 'Sofa', widthCm: 600 })
    expect(JSON.stringify(store.getHome().furniture)).toBe(before)
  })
})
