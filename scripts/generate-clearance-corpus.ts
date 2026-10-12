/**
 * Regenerates tests/fixtures/furniture-clearance-corpus.json: a fixed set of
 * rooms, walls (straight and round) and furniture with the clearance verdicts
 * the app computes for them. The corpus is the contract between the two
 * implementations of the clearance rules: src/core/furniture-clearance.ts (the
 * store) and mcp/furniture_clearance.py (the MCP validator). Both test suites
 * recompute every case and must reproduce the committed verdicts.
 *
 *   npm run clearance:corpus
 *
 * Hand-written cases pin the interesting geometry (exact fits, round rooms,
 * partial arcs, levels, elevation); the seeded random cases fill the space
 * around them. Re-run only when the rules intentionally change.
 */
import { writeFileSync } from 'node:fs'
import { enforceFurnitureClearance, findClearanceViolations, FurnitureTooLargeError } from '../src/core/furniture-clearance'

interface Wall { id: string; xStart: number; yStart: number; xEnd: number; yEnd: number; thickness: number; arcExtent?: number; height?: number; heightAtEnd?: number; levelRef?: string }
interface Room { id: string; name: string; points: Array<[number, number]>; levelRef?: string }
interface Piece { id: string; name: string; x: number; y: number; angleDeg: number; width: number; depth: number; height: number; elevation: number; doorOrWindow?: boolean; levelRef?: string }
interface Case { name: string; home: { walls: Wall[]; rooms: Room[]; furniture: Piece[] } }

const r2 = (n: number): number => Math.round(n * 100) / 100
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6

function rectRoom(prefix: string, x0: number, y0: number, x1: number, y1: number, thickness = 10, extra: Partial<Wall> = {}, levelRef?: string): { walls: Wall[]; room: Room } {
  const pts: Array<[number, number]> = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  const lvl = levelRef ? { levelRef } : {}
  const walls = pts.map(([xs, ys], i) => {
    const [xe, ye] = pts[(i + 1) % 4]!
    return { id: `${prefix}-w${i + 1}`, xStart: xs, yStart: ys, xEnd: xe, yEnd: ye, thickness, ...extra, ...lvl }
  })
  return { walls, room: { id: `${prefix}-room`, name: `${prefix} room`, points: pts, ...lvl } }
}

/** Round room: two half-circle arc walls (counter-clockwise bulge) + a polygon floor. */
function roundRoom(prefix: string, cx: number, cy: number, radius: number, thickness = 10, levelRef?: string): { walls: Wall[]; room: Room } {
  const lvl = levelRef ? { levelRef } : {}
  const walls: Wall[] = [
    { id: `${prefix}-w1`, xStart: cx - radius, yStart: cy, xEnd: cx + radius, yEnd: cy, thickness, arcExtent: Math.PI, ...lvl },
    { id: `${prefix}-w2`, xStart: cx + radius, yStart: cy, xEnd: cx - radius, yEnd: cy, thickness, arcExtent: Math.PI, ...lvl },
  ]
  const points: Array<[number, number]> = []
  for (let i = 0; i < 32; i++) points.push([r2(cx + radius * Math.cos((2 * Math.PI * i) / 32)), r2(cy + radius * Math.sin((2 * Math.PI * i) / 32))])
  return { walls, room: { id: `${prefix}-room`, name: `${prefix} room`, points, ...lvl } }
}

let pieceCounter = 0
function piece(x: number, y: number, width: number, depth: number, angleDeg = 0, over: Partial<Piece> = {}): Piece {
  pieceCounter++
  return { id: `f${pieceCounter}`, name: `Piece ${pieceCounter}`, x, y, angleDeg, width, depth, height: 80, elevation: 0, ...over }
}

function build(name: string, parts: Array<{ walls: Wall[]; room?: Room }>, furniture: Piece[], extraWalls: Wall[] = []): Case {
  return { name, home: { walls: [...parts.flatMap((p) => p.walls), ...extraWalls], rooms: parts.flatMap((p) => (p.room ? [p.room] : [])), furniture } }
}

function handwritten(): Case[] {
  const cases: Case[] = []
  const box = rectRoom('box', 0, 0, 400, 400)
  cases.push(build('rect room: fits, touches a wall, oversize, legacy overlap', [box], [
    piece(200, 200, 120, 60),
    piece(200, 36, 120, 60),
    piece(200, 200, 500, 90),
    piece(2, 200, 60, 60),
    piece(200, 200, 390, 390),
    piece(200, 200, 395, 395, 45),
  ]))
  const exact = rectRoom('exact', 0, 0, 310, 310) // 300 cm interior
  cases.push(build('exact flush fit and one millimetre too big', [exact], [
    piece(155, 155, 300, 300),
    piece(100, 100, 300.1, 300),
    piece(155, 155, 299.99, 200),
    piece(155, 155, 424, 10, 45),
    piece(155, 155, 430, 10, 45),
  ]))
  const circle = roundRoom('circle', 0, 0, 200)
  cases.push(build('round room: centred, edge, oversize, diagonal', [circle], [
    piece(0, 0, 100, 100),
    piece(0, 0, 360, 40),
    piece(0, 0, 380, 40),
    piece(0, 0, 360, 40, 37),
    piece(150, 0, 100, 100),
    piece(190, 0, 60, 60),
    piece(0, 0, 500, 500),
    piece(60, 60, 200, 200, 45),
    piece(0, 0, 280, 280, 45),
    piece(0, 0, 276, 276, 45),
  ]))
  const tight = roundRoom('tight', 0, 0, 120)
  cases.push(build('tight round room: sofa across, too long, legacy overlap', [tight], [
    piece(0, 0, 150, 150),
    piece(0, 0, 200, 200),
    piece(0, 0, 220, 30),
    piece(0, 0, 240, 30, 90),
    piece(80, 0, 90, 40),
    piece(0, 90, 120, 60),
    piece(0, 0, 215, 40, 19),
  ]))
  const bigCircle = roundRoom('big', 0, 0, 1200, 20)
  cases.push(build('large round room', [bigCircle], [
    piece(0, 0, 400, 200),
    piece(1000, 0, 200, 200),
    piece(0, 1150, 300, 100, 80),
    piece(0, 0, 2300, 100),
    piece(0, 0, 2500, 100),
  ]))
  const reversed: Wall[] = [
    { id: 'rev-w1', xStart: 200, yStart: 0, xEnd: -200, yEnd: 0, thickness: 10, arcExtent: -Math.PI },
    { id: 'rev-w2', xStart: -200, yStart: 0, xEnd: 200, yEnd: 0, thickness: 10, arcExtent: -Math.PI },
  ]
  cases.push(build('clockwise arc walls', [{ walls: reversed, room: roundRoom('rev', 0, 0, 200).room }], [
    piece(0, 0, 100, 100), piece(0, 0, 500, 100), piece(180, 0, 80, 80), piece(0, 0, 360, 40, 12),
  ]))
  const quarter: Wall[] = [
    { id: 'q-w1', xStart: 0, yStart: 0, xEnd: 300, yEnd: 0, thickness: 10 },
    { id: 'q-w2', xStart: 300, yStart: 0, xEnd: 300, yEnd: 300, thickness: 10, arcExtent: Math.PI / 2 },
    { id: 'q-w3', xStart: 300, yStart: 300, xEnd: 0, yEnd: 300, thickness: 10 },
    { id: 'q-w4', xStart: 0, yStart: 300, xEnd: 0, yEnd: 0, thickness: 10 },
  ]
  cases.push(build('rectangle with one bulging arc wall', [{ walls: quarter, room: { id: 'q-room', name: 'Bow', points: [[0, 0], [300, 0], [300, 300], [0, 300]] } }], [
    piece(150, 150, 100, 100), piece(330, 150, 80, 80), piece(300, 150, 60, 60), piece(150, 150, 320, 100), piece(150, 150, 280, 280),
  ]))
  const free: Wall[] = [{ id: 'free-w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 20 }, { id: 'free-w2', xStart: 200, yStart: -100, xEnd: 200, yEnd: 100, thickness: 10 }]
  cases.push(build('furniture outside any room', [{ walls: free }], [
    piece(200, 0, 100, 40), piece(50, 5, 80, 30, 30), piece(500, 300, 60, 60), piece(200, 50, 60, 60),
  ]))
  const trap: Wall[] = [
    { id: 'trap-w1', xStart: 0, yStart: 0, xEnd: 100, yEnd: 0, thickness: 10 },
    { id: 'trap-w2', xStart: 100, yStart: 0, xEnd: 100, yEnd: 100, thickness: 10 },
    { id: 'trap-w3', xStart: 100, yStart: 100, xEnd: 0, yEnd: 100, thickness: 10 },
    { id: 'trap-w4', xStart: 0, yStart: 100, xEnd: 0, yEnd: 0, thickness: 10 },
  ]
  cases.push(build('piece trapped in a closet with no room polygon', [{ walls: trap }], [piece(50, 50, 200, 200), piece(50, 50, 60, 60), piece(50, 50, 91, 91)]))
  const lower = rectRoom('lower', 0, 0, 300, 300, 10)
  const upper = rectRoom('upper', 0, 0, 600, 600, 10, {}, 'L2')
  cases.push(build('levels: a piece only meets walls of its own level', [lower, upper], [
    piece(150, 150, 120, 60),
    piece(150, 0, 100, 40, 0, { levelRef: 'L2' }),
    piece(450, 450, 400, 400, 0, { levelRef: 'L2' }),
    piece(450, 450, 700, 100, 0, { levelRef: 'L2' }),
    piece(580, 300, 60, 60),
  ]))
  const tall = rectRoom('tall', 0, 0, 400, 400, 10, { height: 300 })
  cases.push(build('elevation: pieces hung above and below the wall tops', [tall], [
    piece(200, 0, 100, 40, 0, { elevation: 0 }),
    piece(200, 0, 100, 40, 0, { elevation: 140, height: 70 }),
    piece(200, 0, 100, 40, 0, { elevation: 299 }),
    piece(200, 0, 100, 40, 0, { elevation: 300 }),
    piece(200, 200, 600, 600, 0, { elevation: 320 }),
    piece(200, 200, 600, 600, 0, { elevation: 250 }),
  ]))
  const sloped: Wall[] = [
    { id: 'slope-w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 10, height: 100, heightAtEnd: 260 },
    { id: 'slope-w2', xStart: 0, yStart: 200, xEnd: 400, yEnd: 200, thickness: 10 },
  ]
  cases.push(build('sloped wall: the higher end decides', [{ walls: sloped }], [
    piece(50, 0, 80, 40, 0, { elevation: 120 }), piece(50, 0, 80, 40, 0, { elevation: 255 }), piece(50, 0, 80, 40, 0, { elevation: 260 }),
  ]))
  cases.push(build('doors and windows are exempt', [box], [
    piece(200, 0, 90, 10, 0, { doorOrWindow: true }), piece(0, 200, 10, 120, 90, { doorOrWindow: true, elevation: 90 }), piece(200, 0, 90, 10),
  ]))
  return cases
}

/** Small deterministic PRNG (mulberry32) so the corpus regenerates identically. */
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

function randomCases(count: number): Case[] {
  const rand = rng(20261012)
  const between = (lo: number, hi: number): number => r2(lo + rand() * (hi - lo))
  const cases: Case[] = []
  for (let n = 0; n < count; n++) {
    const parts: Array<{ walls: Wall[]; room?: Room }> = []
    const kind = rand()
    if (kind < 0.35) {
      const w = between(150, 600)
      const d = between(150, 600)
      parts.push(rectRoom(`r${n}`, 0, 0, w, d, between(5, 30)))
    } else if (kind < 0.7) {
      parts.push(roundRoom(`c${n}`, 0, 0, between(90, 500), between(5, 30)))
    } else {
      const w = between(250, 600)
      const d = between(250, 600)
      const bow = rectRoom(`b${n}`, 0, 0, w, d, between(5, 30))
      bow.walls[1]!.arcExtent = r2((rand() < 0.5 ? 1 : -1) * between(0.3, 2.2))
      parts.push(bow)
      if (rand() < 0.5) parts.push({ walls: [{ id: `p${n}`, xStart: w / 2, yStart: 0, xEnd: w / 2, yEnd: d * 0.6, thickness: between(5, 20) }] })
    }
    const furniture: Piece[] = []
    const pts = parts.flatMap((part) => part.room?.points ?? part.walls.flatMap((w) => [[w.xStart, w.yStart], [w.xEnd, w.yEnd]] as Array<[number, number]>))
    const minX = Math.min(...pts.map((p) => p[0]))
    const maxX = Math.max(...pts.map((p) => p[0]))
    const minY = Math.min(...pts.map((p) => p[1]))
    const maxY = Math.max(...pts.map((p) => p[1]))
    const span = Math.min(maxX - minX, maxY - minY)
    const pieces = 3 + Math.floor(rand() * 4)
    for (let i = 0; i < pieces; i++) {
      // Mostly inside the room, sized from small to a little over the room's width.
      const width = between(20, span * 1.15)
      furniture.push(piece(between(minX - 30, maxX + 30), between(minY - 30, maxY + 30), width, between(20, Math.min(width, span * 0.8)), Math.round(between(-180, 180)), {
        elevation: rand() < 0.2 ? between(0, 320) : 0,
      }))
    }
    cases.push(build(`random ${n}`, parts, furniture))
  }
  return cases
}

/** Where the store's invariant puts each piece when it is the only new one (null = rejected as too large). */
function resolvedPositions(home: Case['home']): Record<string, [number, number] | null> {
  const out: Record<string, [number, number] | null> = {}
  for (const item of home.furniture) {
    const draft = { walls: home.walls, rooms: home.rooms, furniture: [{ ...item }] }
    try {
      enforceFurnitureClearance(draft as never, { walls: home.walls, rooms: home.rooms, furniture: [] } as never)
      out[item.id] = [r6(draft.furniture[0]!.x), r6(draft.furniture[0]!.y)]
    } catch (err) {
      if (!(err instanceof FurnitureTooLargeError)) throw err
      out[item.id] = null
    }
  }
  return out
}

const cases = [...handwritten(), ...randomCases(160)].map((c) => {
  const found = findClearanceViolations({ walls: c.home.walls, rooms: c.home.rooms, furniture: c.home.furniture } as never)
  return {
    ...c,
    expected: {
      overlaps: found.overlaps.map((o) => [o.furnitureId, o.wallId]).sort(),
      oversize: found.oversize.map((o) => o.furnitureId).sort(),
      resolved: resolvedPositions(c.home),
    },
  }
})

const target = new URL('../tests/fixtures/furniture-clearance-corpus.json', import.meta.url)
writeFileSync(target, `${JSON.stringify({ description: 'Generated by scripts/generate-clearance-corpus.ts; verdicts are the contract between src/core/furniture-clearance.ts and mcp/furniture_clearance.py.', cases })}\n`)
const flagged = cases.filter((c) => c.expected.overlaps.length || c.expected.oversize.length).length
console.log(`wrote ${cases.length} cases (${flagged} with at least one overlap or oversize piece)`)
