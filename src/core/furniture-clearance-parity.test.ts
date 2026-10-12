import { describe, expect, it } from 'vitest'
import corpus from '../../tests/fixtures/furniture-clearance-corpus.json'
import { enforceFurnitureClearance, findClearanceViolations, FurnitureTooLargeError } from './furniture-clearance'

interface CorpusCase {
  name: string
  home: Parameters<typeof findClearanceViolations>[0]
  expected: { overlaps: Array<[string, string]>; oversize: string[]; resolved: Record<string, [number, number] | null> }
}

const cases = corpus.cases as unknown as CorpusCase[]

/** Same corpus, same expected verdicts as mcp/test_clearance_parity.py: the TS store and the Python MCP validator must agree. */
describe('clearance verdicts match the shared corpus (mirrored in mcp/test_clearance_parity.py)', () => {
  it('covers every kind of verdict', () => {
    const overlaps = cases.reduce((n, c) => n + c.expected.overlaps.length, 0)
    const oversize = cases.reduce((n, c) => n + c.expected.oversize.length, 0)
    const pieces = cases.reduce((n, c) => n + c.home.furniture.length, 0)
    const flagged = cases.reduce((n, c) => n + new Set([...c.expected.overlaps.map(([id]) => id), ...c.expected.oversize]).size, 0)
    expect(cases.length).toBeGreaterThan(150)
    expect(overlaps).toBeGreaterThan(50)
    expect(oversize).toBeGreaterThan(50)
    expect(pieces - flagged).toBeGreaterThan(100)
    expect(cases.some((c) => c.home.walls.some((w) => w.arcExtent))).toBe(true)
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const found = findClearanceViolations(c.home)
    expect(found.overlaps.map((o) => [o.furnitureId, o.wallId]).sort()).toEqual(c.expected.overlaps)
    expect(found.oversize.map((o) => o.furnitureId).sort()).toEqual(c.expected.oversize)
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s: pieces end up where the corpus says', (_name, c) => {
    for (const item of c.home.furniture) {
      const draft = { walls: c.home.walls, rooms: c.home.rooms, furniture: [{ ...item }] }
      let resolved: [number, number] | null
      try {
        enforceFurnitureClearance(draft as never, { walls: c.home.walls, rooms: c.home.rooms, furniture: [] } as never)
        resolved = [draft.furniture[0]!.x, draft.furniture[0]!.y]
      } catch (err) {
        if (!(err instanceof FurnitureTooLargeError)) throw err
        resolved = null
      }
      const expected = c.expected.resolved[item.id]!
      if (expected === null) expect(resolved, item.id).toBeNull()
      else {
        expect(resolved, item.id).not.toBeNull()
        expect(resolved![0], item.id).toBeCloseTo(expected[0], 5)
        expect(resolved![1], item.id).toBeCloseTo(expected[1], 5)
      }
    }
  })
})
