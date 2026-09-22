import { describe, it, expect } from 'vitest'
import {
  deriveWallSideExterior,
  getWallSideExterior,
  wallSideOutwardNormal,
} from './wall-exterior'
import type { RoomPolygon } from './wall-exterior'

// Horizontal wall along +X: right side faces z<0, left side faces z>0
const wall = { xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15 }

describe('wallSideOutwardNormal', () => {
  it('returns right normal (uy, -ux) for a +X wall', () => {
    expect(wallSideOutwardNormal(wall, 'right')).toEqual({ nx: 0, ny: -1 })
  })

  it('returns left normal (-uy, ux) for a +X wall', () => {
    expect(wallSideOutwardNormal(wall, 'left')).toEqual({ nx: 0, ny: 1 })
  })

  it('guards degenerate zero-length walls', () => {
    const degenerate = { xStart: 5, yStart: 5, xEnd: 5, yEnd: 5 }
    expect(wallSideOutwardNormal(degenerate, 'right')).toEqual({ nx: 0, ny: 0 })
  })
})

describe('deriveWallSideExterior', () => {
  it('returns exterior for both sides when there are no rooms', () => {
    expect(deriveWallSideExterior(wall, 'right', [])).toBe(true)
    expect(deriveWallSideExterior(wall, 'left', [])).toBe(true)
  })

  it('marks the room side interior and the opposite side exterior', () => {
    const rooms: RoomPolygon[] = [
      // Right-side room: contains sample point (200, -12.5)
      { points: [[0, -200], [400, -200], [400, -5], [0, -5]] },
    ]
    expect(deriveWallSideExterior(wall, 'right', rooms)).toBe(false)
    expect(deriveWallSideExterior(wall, 'left', rooms)).toBe(true)
  })

  it('marks both sides interior for two adjacent rooms sharing the wall', () => {
    const rooms: RoomPolygon[] = [
      { points: [[0, -200], [400, -200], [400, -5], [0, -5]] },
      { points: [[0, 5], [400, 5], [400, 200], [0, 200]] },
    ]
    expect(deriveWallSideExterior(wall, 'right', rooms)).toBe(false)
    expect(deriveWallSideExterior(wall, 'left', rooms)).toBe(false)
  })

  it('ignores rooms on a different levelRef', () => {
    const rooms: RoomPolygon[] = [
      { points: [[0, -200], [400, -200], [400, -5], [0, -5]], levelRef: 'floor-2' },
    ]
    expect(deriveWallSideExterior(wall, 'right', rooms)).toBe(true)
  })

  it('matches walls and rooms on the same levelRef', () => {
    const raisedWall = { ...wall, levelRef: 'floor-2' }
    const rooms: RoomPolygon[] = [
      { points: [[0, -200], [400, -200], [400, -5], [0, -5]], levelRef: 'floor-2' },
    ]
    expect(deriveWallSideExterior(raisedWall, 'right', rooms)).toBe(false)
  })
})

describe('getWallSideExterior', () => {
  it('boolean override short-circuits derivation', () => {
    const rooms: RoomPolygon[] = [
      { points: [[0, -200], [400, -200], [400, -5], [0, -5]] },
    ]
    expect(
      getWallSideExterior({ ...wall, rightSideExteriorOverride: true }, 'right', rooms),
    ).toBe(true)
    expect(
      getWallSideExterior({ ...wall, leftSideExteriorOverride: false }, 'left', rooms),
    ).toBe(false)
  })

  it('null or absent override falls back to derivation', () => {
    const rooms: RoomPolygon[] = [
      { points: [[0, -200], [400, -200], [400, -5], [0, -5]] },
    ]
    expect(getWallSideExterior({ ...wall, rightSideExteriorOverride: null }, 'right', rooms)).toBe(false)
    expect(getWallSideExterior(wall, 'right', rooms)).toBe(false)
  })
})
