import { describe, expect, it } from 'vitest'
import { FloorDetectionCache, faceHasRoom, formatAreaM2, snapRoomPoint, toFloorWalls, uncoveredFaceAt, type AssistWall } from './floor-assist'

const wall = (id: string, xStart: number, yStart: number, xEnd: number, yEnd: number, levelRef: string | null = null): AssistWall => ({ id, xStart, yStart, xEnd, yEnd, levelRef })
const box: AssistWall[] = [wall('a', 0, 0, 400, 0), wall('b', 400, 0, 400, 300), wall('c', 400, 300, 0, 300), wall('d', 0, 300, 0, 0)]
const any = () => true

describe('floor-assist', () => {
  it('filters walls by level and finds the uncovered face under the cursor', () => {
    const walls = toFloorWalls([...box, wall('x', 0, 0, 10, 10, 'L2')], (l) => (l ?? null) === null)
    expect(walls).toHaveLength(4)
    const cache = new FloorDetectionCache()
    const faces = cache.faces(walls)
    expect(cache.faces(walls)).toBe(faces) // memoised
    expect(uncoveredFaceAt(faces, [], { x: 200, y: 150 }, any)!.area).toBeCloseTo(120000)
    const room = { points: [[0, 0], [400, 0], [400, 300], [0, 300]] as Array<[number, number]>, levelRef: null }
    expect(faceHasRoom(faces[0]!, [room], any)).toBe(true)
    expect(uncoveredFaceAt(faces, [room], { x: 200, y: 150 }, any)).toBeNull()
    expect(faceHasRoom(faces[0]!, [{ ...room, levelRef: 'L2' }], (l) => (l ?? null) === null)).toBe(false)
  })

  it('reports a near-closed gap through the cache', () => {
    const open = toFloorWalls([wall('a', 0, 0, 400, 0), wall('b', 400, 0, 400, 300), wall('c', 400, 300, 0, 300), wall('d', 0, 300, 0, 60)], any)
    const gaps = new FloorDetectionCache().gaps(open, 150)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.distance).toBeCloseTo(60)
  })

  it('formats area in m²', () => {
    expect(formatAreaM2(120000)).toBe('12.00 m²')
  })
})

describe('snapRoomPoint', () => {
  const corners = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }]
  it('snaps to a corner within the radius, preferring it over alignment and grid', () => {
    const r = snapRoomPoint({ point: { x: 397, y: 4 }, radius: 10, corners, prev: null, first: null, grid: (p) => ({ x: Math.round(p.x / 50) * 50, y: Math.round(p.y / 50) * 50 }) })
    expect(r.kind).toBe('corner')
    expect(r.point).toEqual({ x: 400, y: 0 })
  })
  it('aligns with previous vertex / corners with guides when not on a corner', () => {
    const r = snapRoomPoint({ point: { x: 203, y: 297 }, radius: 10, corners, prev: { x: 200, y: 120 }, first: null })
    expect(r.kind).toBe('align')
    expect(r.point.x).toBe(200)
    expect(r.guides.length).toBeGreaterThan(0)
  })
  it('falls back to grid, then to the raw point', () => {
    const grid = (p: { x: number; y: number }) => ({ x: Math.round(p.x / 10) * 10, y: Math.round(p.y / 10) * 10 })
    expect(snapRoomPoint({ point: { x: 123, y: 87 }, radius: 10, corners, prev: null, first: null, grid }).point).toEqual({ x: 120, y: 90 })
    expect(snapRoomPoint({ point: { x: 123, y: 87 }, radius: 10, corners, prev: null, first: null }).kind).toBe('none')
  })
})
