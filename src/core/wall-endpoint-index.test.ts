import { describe, expect, it } from 'vitest'
import type { Wall } from './home'
import { buildWallEndpointIndex } from './wall-endpoint-index'

function wall(id: string, xStart: number, yStart: number, xEnd: number, yEnd: number): Wall {
  return { id, xStart, yStart, xEnd, yEnd, thickness: 10 } as Wall
}

describe('buildWallEndpointIndex', () => {
  it('(a) finds nothing for an isolated wall endpoint', () => {
    const index = buildWallEndpointIndex([wall('a', 0, 0, 100, 0)])
    expect(index.matchesAt(0, 0, 'a')).toMatchObject([])
    expect(index.matchesAt(100, 0, 'a')).toMatchObject([])
    expect(index.matchesAt(50, 0, 'a')).toMatchObject([])
  })

  it('(b) matches two walls sharing an endpoint, queried from either side', () => {
    const a = wall('a', 0, 0, 100, 0)
    const b = wall('b', 100, 0, 200, 50)
    const index = buildWallEndpointIndex([a, b])

    // From a's end → b's start.
    expect(index.matchesAt(100, 0, 'a')).toMatchObject([{ wallId: 'b', atStart: true }])
    // From b's start → a's end.
    expect(index.matchesAt(100, 0, 'b')).toMatchObject([{ wallId: 'a', atStart: false }])
    // The match carries the wall object itself so callers never re-scan by id.
    expect(index.matchesAt(100, 0, 'a')[0]!.wall).toBe(b)
  })

  it('(c) excludeWallId removes self matches but keeps others', () => {
    const a = wall('a', 0, 0, 100, 0)
    const b = wall('b', 100, 0, 200, 0)
    const index = buildWallEndpointIndex([a, b])

    expect(index.matchesAt(100, 0, 'a')).toMatchObject([{ wallId: 'b', atStart: true }])
    expect(index.matchesAt(100, 0, 'b')).toMatchObject([{ wallId: 'a', atStart: false }])
    // No exclusion → both endpoints at that point (a's end and b's start).
    expect(index.matchesAt(100, 0)).toMatchObject([
      { wallId: 'a', atStart: false },
      { wallId: 'b', atStart: true },
    ])
  })

  it('(d) a 3-way shared endpoint returns all three walls (self excluded per query)', () => {
    const a = wall('a', 0, 0, 100, 0)
    const b = wall('b', 100, 0, 100, 100)
    const c = wall('c', 100, 0, 200, 0)
    const index = buildWallEndpointIndex([a, b, c])

    expect(index.matchesAt(100, 0, 'a')).toMatchObject([
      { wallId: 'b', atStart: true },
      { wallId: 'c', atStart: true },
    ])
    expect(index.matchesAt(100, 0, 'b')).toMatchObject([
      { wallId: 'a', atStart: false },
      { wallId: 'c', atStart: true },
    ])
    expect(index.matchesAt(100, 0, 'c')).toMatchObject([
      { wallId: 'a', atStart: false },
      { wallId: 'b', atStart: true },
    ])
  })

  it('(e) endpoints within EPSILON (EPSILON/2 apart) still match', () => {
    const half = 1e-6 / 2
    const a = wall('a', 0, 0, 100, 0)
    const b = wall('b', 100 + half, half, 200, 0)
    const index = buildWallEndpointIndex([a, b])

    expect(index.matchesAt(100, 0, 'a')).toMatchObject([{ wallId: 'b', atStart: true }])
  })

  it('(f) endpoints clearly outside EPSILON (1cm apart) do not match', () => {
    const a = wall('a', 0, 0, 100, 0)
    const b = wall('b', 101, 0, 200, 0)
    const index = buildWallEndpointIndex([a, b])

    expect(index.matchesAt(100, 0, 'a')).toMatchObject([])
    expect(index.matchesAt(101, 0, 'b')).toMatchObject([])
  })

  it('(g) endpoints within EPSILON straddling a grid-cell boundary still match', () => {
    // GRID_CM = 2e-6, so floor(x/GRID_CM) flips at x = 0: ±4.9e-7 land in
    // cells 0 and -1. The near endpoints are 4.9e-7 apart (< EPSILON = 1e-6)
    // → must still match via the 3x3 neighborhood scan.
    const a = wall('a', 0, 0, 100, 0)
    const b = wall('b', -4.9e-7, 0, -100, 0)
    const index = buildWallEndpointIndex([a, b])
    expect(Math.floor(0 / 2e-6)).not.toBe(Math.floor(-4.9e-7 / 2e-6))

    expect(index.matchesAt(0, 0, 'a')).toMatchObject([{ wallId: 'b', atStart: true }])
    expect(index.matchesAt(-4.9e-7, 0, 'b')).toMatchObject([{ wallId: 'a', atStart: true }])
  })
})
