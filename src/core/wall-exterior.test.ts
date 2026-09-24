import { describe, it, expect } from 'vitest'
import {
  deriveWallSideExterior,
  getEffectiveWallSideTextureId,
  getWallSideExterior,
  wallSideOutwardNormal,
} from './wall-exterior'
import type { RoomPolygon } from './wall-exterior'
import type { HomePreferences } from './home'

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

describe('getEffectiveWallSideTextureId', () => {
  // wall's right side sample point (200, -12.5): inside this room → interior;
  // with no rooms → exterior.
  const interiorRooms: RoomPolygon[] = [
    { points: [[0, -200], [400, -200], [400, -5], [0, -5]] },
  ]

  it('explicit string texture wins regardless of side classification', () => {
    expect(getEffectiveWallSideTextureId({ ...wall, leftSideTextureId: 'wood-oak' }, 'left', [], undefined)).toBe('wood-oak')
    expect(
      getEffectiveWallSideTextureId({ ...wall, rightSideTextureId: 'concrete' }, 'right', interiorRooms, {
        defaultFloorColor: 0xffffff,
        defaultFloorShininess: 0,
        defaultCeilingColor: 0xffffff,
        defaultInteriorWallTextureId: 'tile-floor',
      }),
    ).toBe('concrete')
  })

  it('explicit null wins over preferences (returns null, not plaster-white)', () => {
    expect(
      getEffectiveWallSideTextureId({ ...wall, rightSideTextureId: null }, 'right', [], {
        defaultFloorColor: 0xffffff,
        defaultFloorShininess: 0,
        defaultCeilingColor: 0xffffff,
        defaultExteriorWallTextureId: 'wood-pine',
      }),
    ).toBeNull()
  })

  it('undefined + no preferences resolves to plaster-white on both classifications', () => {
    expect(getEffectiveWallSideTextureId(wall, 'right', [], undefined)).toBe('plaster-white')
    expect(getEffectiveWallSideTextureId(wall, 'right', interiorRooms, undefined)).toBe('plaster-white')
  })

  it('undefined side falls back to the matching exterior/interior preference', () => {
    const prefs: HomePreferences = {
      defaultFloorColor: 0xffffff,
      defaultFloorShininess: 0,
      defaultCeilingColor: 0xffffff,
      defaultExteriorWallTextureId: 'wood-pine',
      defaultInteriorWallTextureId: 'tile-floor',
    }
    expect(getEffectiveWallSideTextureId(wall, 'right', [], prefs)).toBe('wood-pine')
    expect(getEffectiveWallSideTextureId(wall, 'right', interiorRooms, prefs)).toBe('tile-floor')
  })

  it('null interior preference passes through as null', () => {
    const prefs: HomePreferences = {
      defaultFloorColor: 0xffffff,
      defaultFloorShininess: 0,
      defaultCeilingColor: 0xffffff,
      defaultInteriorWallTextureId: null,
    }
    expect(getEffectiveWallSideTextureId(wall, 'right', interiorRooms, prefs)).toBeNull()
  })
})
