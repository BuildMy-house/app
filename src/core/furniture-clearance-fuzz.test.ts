import { describe, expect, it } from 'vitest'
import { ClipboardManager } from '../plan/clipboard'
import { findClearanceViolations, FurnitureTooLargeError } from './furniture-clearance'
import { HomeModel } from './model'
import { HomeStore } from './store'

/** Small deterministic PRNG (mulberry32) so failures replay from the seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const STEPS = 120
// 600 seeds were run clean once; 60 keeps CI at a few seconds. Raise to hunt.
const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1)

function run(seed: number): void {
  const rand = rng(seed)
  const pick = <T,>(xs: ReadonlyArray<T>): T => xs[Math.floor(rand() * xs.length)]!
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo)
  const store = new HomeStore()
  const model = new HomeModel(store)
  const clipboard = new ClipboardManager(store, model)
  const trace: string[] = []

  // Two rooms side by side; random extra walls (some curved) cut across them.
  const box = (l: number, t: number, r: number, b: number, name: string) => {
    const pts: Array<[number, number]> = [[l, t], [r, t], [r, b], [l, b]]
    pts.forEach(([xs, ys], i) => {
      const [xe, ye] = pts[(i + 1) % 4]!
      model.addWall({ xStart: xs, yStart: ys, xEnd: xe, yEnd: ye, thickness: 10 })
    })
    model.addRoom(pts, { name })
  }
  box(0, 0, 500, 400, 'A')
  box(600, 0, 800, 300, 'B')

  const fail = (msg: string): never => {
    throw new Error(`seed ${seed}: ${msg}\n  trace: ${trace.slice(-8).join(' | ')}`)
  }

  const checkInvariants = () => {
    const home = store.peek()
    const v = findClearanceViolations(home)
    if (v.overlaps.length > 0) fail(`overlap ${JSON.stringify(v.overlaps[0])}`)
    if (v.oversize.length > 0) fail(`oversize ${JSON.stringify(v.oversize[0])}`)
  }

  const edit = (label: string, action: () => void) => {
    const undoBefore = store.canUndo()
    const snapshot = JSON.stringify(store.peek())
    trace.push(label)
    try {
      action()
    } catch (err) {
      if (!(err instanceof FurnitureTooLargeError)) throw err
      // A refused edit must leave no trace at all.
      if (JSON.stringify(store.peek()) !== snapshot) fail(`rejected edit changed state: ${label}`)
      if (store.canUndo() !== undoBefore) fail(`rejected edit changed undo stack: ${label}`)
    }
  }

  for (let step = 0; step < STEPS; step++) {
    const home = store.peek()
    const furniture = home.furniture
    const walls = home.walls
    const op = pick(['add', 'add', 'move', 'move', 'rotate', 'resize', 'wallAdd', 'wallMove', 'wallDelete', 'undo', 'redo', 'paste', 'delete', 'elevate'])
    switch (op) {
      case 'add':
        edit('add', () => model.addFurniture({ name: 'F', x: between(-50, 850), y: between(-50, 450), angleDeg: between(0, 360), width: between(20, 220), depth: between(20, 220), height: 80, elevation: pick([0, 0, 0, 120]) }))
        break
      case 'move':
        if (furniture.length) { const f = pick(furniture); edit(`move ${f.id}`, () => model.updateFurniture(f.id, { x: between(-50, 850), y: between(-50, 450) })) }
        break
      case 'rotate':
        if (furniture.length) { const f = pick(furniture); edit(`rotate ${f.id}`, () => model.updateFurniture(f.id, { angleDeg: between(0, 360) })) }
        break
      case 'resize':
        if (furniture.length) { const f = pick(furniture); edit(`resize ${f.id}`, () => model.updateFurniture(f.id, { width: between(20, 300), depth: between(20, 300) })) }
        break
      case 'elevate':
        if (furniture.length) { const f = pick(furniture); edit(`elevate ${f.id}`, () => model.updateFurniture(f.id, { elevation: pick([0, 100, 249, 260]) })) }
        break
      case 'wallAdd':
        edit('wallAdd', () => model.addWall({ xStart: between(0, 800), yStart: between(0, 400), xEnd: between(0, 800), yEnd: between(0, 400), thickness: 10, ...(rand() < 0.4 ? { arcExtent: between(-2.5, 2.5) } : {}) }))
        break
      case 'wallMove':
        if (walls.length) { const w = pick(walls); edit(`wallMove ${w.id}`, () => model.setWallEndpoint(w.id, pick(['start', 'end'] as const), between(0, 800), between(0, 400))) }
        break
      case 'wallDelete':
        if (walls.length) { const w = pick(walls); edit(`wallDelete ${w.id}`, () => model.removeWall(w.id)) }
        break
      case 'delete':
        if (furniture.length) { const f = pick(furniture); edit(`delete ${f.id}`, () => model.removeFurniture(f.id)) }
        break
      case 'paste':
        if (furniture.length) {
          const f = pick(furniture)
          model.setSelection([f.id]) // selecting is not part of the edit under test
          clipboard.copy()
          edit('paste', () => clipboard.paste())
        }
        break
      case 'undo': {
        const could = store.canUndo()
        const redoBefore = store.canRedo()
        trace.push('undo')
        const did = store.undo()
        if (did !== could) fail('undo() disagrees with canUndo()')
        if (did && !store.canRedo()) fail('redo stack empty after a successful undo')
        if (!did && store.canRedo() !== redoBefore) fail('a no-op undo changed the redo stack')
        break
      }
      case 'redo': {
        const could = store.canRedo()
        trace.push('redo')
        const did = store.redo()
        if (did !== could) fail('redo() disagrees with canRedo()')
        break
      }
    }
    checkInvariants()
  }

  // Draining the undo stack must land on states that are all valid, with the stack bounded.
  let guard = 0
  while (store.canUndo() && guard++ < 100) {
    store.undo()
    checkInvariants()
  }
  expect(guard).toBeLessThanOrEqual(HomeStore.MAX_UNDO_DEPTH + 1)
}

describe('clearance fuzz: random mixed edits never leave a piece overlapping or too large', () => {
  for (const seed of SEEDS) it(`seed ${seed}`, () => run(seed))
})
