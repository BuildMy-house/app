import { describe, expect, it } from 'vitest'
import corpus from '../../tests/fixtures/furniture-clearance-corpus.json'
import { findClearanceViolations } from './furniture-clearance'

interface CorpusCase {
  name: string
  home: Parameters<typeof findClearanceViolations>[0]
  expected: { overlaps: Array<[string, string]>; oversize: string[] }
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
})
