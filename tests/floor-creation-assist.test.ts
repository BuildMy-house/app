// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { HomeModel } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import { PlanEngine, type PlanNotice } from '../src/plan/engine'

function setup(assist = true) {
  const store = new HomeStore()
  const model = new HomeModel(store)
  const engine = new PlanEngine(model)
  engine.setFloorAssist(assist)
  const notices: PlanNotice[] = []
  engine.setNotifier((n) => notices.push(n))
  return { store, model, engine, notices }
}

const click = (engine: PlanEngine, x: number, y: number, dbl = false) => engine.click({ x, y, dbl })

function drawLoop(engine: PlanEngine, pts: Array<[number, number]>): void {
  engine.setTool('wall')
  for (const [x, y] of pts) click(engine, x, y)
}

describe('wall chain closing on its start point', () => {
  it('a single closing click finishes the chain and creates the floor', () => {
    const { store, engine, notices } = setup()
    drawLoop(engine, [[0, 0], [400, 0], [400, 300], [0, 300], [0, 0]])
    const home = store.getHome()
    expect(home.walls).toHaveLength(4)
    expect(home.rooms).toHaveLength(1)
    expect(engine.getPreview().phase).toBe('idle')
    expect(notices.at(-1)).toMatchObject({ tone: 'success', undoable: true })
    expect(notices.at(-1)!.text).toContain('12.00 m²')
  })

  it('the trailing double-click of the gesture does not duplicate or start a new chain', () => {
    const { store, engine } = setup()
    drawLoop(engine, [[0, 0], [400, 0], [400, 300], [0, 300], [0, 0]])
    click(engine, 0, 0) // 2nd click of the dblclick gesture
    click(engine, 0, 0, true)
    expect(store.getHome().rooms).toHaveLength(1)
    expect(store.getHome().walls).toHaveLength(4)
    expect(engine.getPreview().phase).toBe('idle')
  })

  it('undo removes the floor first, then the walls', () => {
    const { store, engine } = setup()
    drawLoop(engine, [[0, 0], [400, 0], [400, 300], [0, 300], [0, 0]])
    store.undo()
    expect(store.getHome().rooms).toHaveLength(0)
    expect(store.getHome().walls).toHaveLength(4)
    store.undo()
    expect(store.getHome().walls).toHaveLength(0)
    store.redo()
    store.redo()
    expect(store.getHome().rooms).toHaveLength(1)
  })

  it('tolerates a small gap: a loop closing 6 cm short still gets a floor', () => {
    const { store, engine } = setup()
    drawLoop(engine, [[0, 0], [400, 0], [400, 300], [0, 300], [0, 6]])
    engine.key('escape')
    expect(store.getHome().rooms).toHaveLength(1)
  })

  it('does nothing extra when assist is off (scripted parity)', () => {
    const { store, engine, notices } = setup(false)
    drawLoop(engine, [[0, 0], [400, 0], [400, 300], [0, 300], [0, 0]])
    click(engine, 0, 0, true)
    expect(store.getHome().rooms).toHaveLength(0)
    expect(notices).toHaveLength(0)
  })
})

describe('near-closed loops and why-not messages', () => {
  it('a 60 cm gap offers closing; clicking the gap closes it and creates the floor in one undo step', () => {
    const { store, engine, notices } = setup()
    drawLoop(engine, [[0, 0], [400, 0], [400, 300], [0, 300], [0, 60]])
    engine.key('escape')
    expect(store.getHome().rooms).toHaveLength(0)
    expect(notices.at(-1)).toMatchObject({ tone: 'warn' })
    expect(notices.at(-1)!.text).toMatch(/gap/i)
    const fa = engine.getPreview().floorAssist
    expect(fa?.gaps).toHaveLength(1)

    click(engine, 0, 30)
    expect(store.getHome().rooms).toHaveLength(1)
    expect(store.getHome().walls).toHaveLength(5)
    store.undo()
    expect(store.getHome().rooms).toHaveLength(0)
    expect(store.getHome().walls).toHaveLength(4)
  })

  it('a chain that encloses nothing explains why', () => {
    const { store, engine, notices } = setup()
    drawLoop(engine, [[0, 0], [400, 0], [400, 300], [800, 900]])
    engine.key('escape')
    expect(store.getHome().rooms).toHaveLength(0)
    expect(notices.at(-1)).toMatchObject({ tone: 'warn' })
  })
})

describe('room tool', () => {
  it('one click inside a closed wall loop creates the floor', () => {
    const { store, model, engine } = setup()
    model.addWall({ xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 7 })
    model.addWall({ xStart: 400, yStart: 0, xEnd: 400, yEnd: 300, thickness: 7 })
    model.addWall({ xStart: 400, yStart: 300, xEnd: 0, yEnd: 300, thickness: 7 })
    model.addWall({ xStart: 0, yStart: 300, xEnd: 0, yEnd: 0, thickness: 7 })
    engine.setTool('room')
    click(engine, 200, 150)
    expect(store.getHome().rooms).toHaveLength(1)
    expect(engine.getPreview().phase).toBe('idle')
    // trailing clicks of the double-click gesture add nothing and start nothing
    click(engine, 200, 150)
    click(engine, 200, 150, true)
    expect(store.getHome().rooms).toHaveLength(1)
    expect(engine.getPreview().phase).toBe('idle')
  })

  it('hover exposes the uncovered face; covered faces are not offered', () => {
    const { model, engine } = setup()
    model.addWall({ xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 7 })
    model.addWall({ xStart: 400, yStart: 0, xEnd: 400, yEnd: 300, thickness: 7 })
    model.addWall({ xStart: 400, yStart: 300, xEnd: 0, yEnd: 300, thickness: 7 })
    model.addWall({ xStart: 0, yStart: 300, xEnd: 0, yEnd: 0, thickness: 7 })
    engine.setTool('room')
    engine.moveMouse(200, 150)
    expect(engine.getPreview().floorAssist?.hoverFace?.areaCm2).toBeCloseTo(120000)
    click(engine, 200, 150)
    engine.moveMouse(200, 150)
    expect(engine.getPreview().floorAssist?.hoverFace).toBeNull()
  })

  it('manual polygon: corners snap to wall corners, live area, Enter finishes', () => {
    const { store, model, engine } = setup()
    model.addWall({ xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 7 })
    engine.setTool('room')
    click(engine, 2, 3) // snaps to (0,0)
    click(engine, 403, 1) // snaps to (400,0)
    engine.moveMouse(400, 300)
    const live = engine.getPreview().floorAssist?.roomLive
    expect(live?.polygon[0]).toEqual({ x: 0, y: 0 })
    expect(live?.polygon[1]).toEqual({ x: 400, y: 0 })
    click(engine, 400, 300)
    expect(engine.finishDrawing()).toBe(true)
    const rooms = store.getHome().rooms
    expect(rooms).toHaveLength(1)
    expect(rooms[0]!.points).toEqual([[0, 0], [400, 0], [400, 300]])
  })

  it('Enter with fewer than 3 corners explains instead of silently dropping', () => {
    const { store, engine, notices } = setup()
    engine.setTool('room')
    click(engine, 0, 0)
    click(engine, 100, 0)
    expect(engine.finishDrawing()).toBe(true)
    expect(store.getHome().rooms).toHaveLength(0)
    expect(notices.at(-1)).toMatchObject({ tone: 'warn' })
  })

  it('Esc cancels the polygon without creating anything', () => {
    const { store, engine } = setup()
    engine.setTool('room')
    click(engine, 0, 0)
    click(engine, 100, 0)
    click(engine, 100, 100)
    engine.key('escape')
    expect(store.getHome().rooms).toHaveLength(0)
    expect(engine.getPreview().phase).toBe('idle')
  })
})
