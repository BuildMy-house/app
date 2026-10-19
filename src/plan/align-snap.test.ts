import { describe, expect, it } from 'vitest'
import {
  ALIGN_CAPTURE_PX,
  alignRadiusCm,
  buildAlignIndex,
  solveAlignment,
  type AlignInput,
} from './align-snap'

const base = (over: Partial<AlignInput>): AlignInput => ({
  index: buildAlignIndex([]),
  start: { x: 500, y: 400 },
  cursor: { x: 0, y: 0 },
  end: { x: 0, y: 0 },
  angleLock: 'none',
  angleDeg: 0,
  hard: false,
  scale: 1,
  bounds: null,
  prev: null,
  ...over,
})

describe('buildAlignIndex', () => {
  it('dedupes coincident vertices and sorts both axes', () => {
    const idx = buildAlignIndex([{ x: 5, y: 1 }, { x: 5, y: 1 }, { x: 1, y: 9 }])
    expect(idx.byX.map((p) => p.x)).toEqual([1, 5])
    expect(idx.byY.map((p) => p.y)).toEqual([1, 9])
  })
})

describe('alignRadiusCm', () => {
  it('is constant on screen: grows when zoomed out, shrinks when zoomed in', () => {
    expect(alignRadiusCm(1)).toBe(ALIGN_CAPTURE_PX)
    expect(alignRadiusCm(0.5)).toBe(ALIGN_CAPTURE_PX * 2)
    expect(alignRadiusCm(3)).toBeCloseTo(ALIGN_CAPTURE_PX / 3)
  })
})

describe('solveAlignment — free angle', () => {
  const index = buildAlignIndex([{ x: 0, y: 0 }, { x: 800, y: 100 }, { x: 0, y: 400 }])

  it('single x guide snaps only x and keeps the cursor y', () => {
    const r = solveAlignment(base({ index, cursor: { x: 5, y: 250 }, end: { x: 5, y: 250 } }))
    expect(r.kind).toBe('guide')
    expect(r.end).toEqual({ x: 0, y: 250 })
    expect(r.guides).toHaveLength(1)
    expect(r.guides[0]!.axis).toBe('x')
  })

  it('x guide from one vertex and y guide from another give an intersection', () => {
    const r = solveAlignment(base({ index, cursor: { x: 797, y: 3 }, end: { x: 797, y: 3 } }))
    // x=800 (vertex 800,100) and y=0 (vertex 0,0)
    expect(r.kind).toBe('intersection')
    expect(r.end).toEqual({ x: 800, y: 0 })
    expect(r.guides.map((g) => g.axis).sort()).toEqual(['x', 'y'])
  })

  it('both guides from the same vertex reports a vertex snap', () => {
    const r = solveAlignment(base({ index, cursor: { x: 4, y: 396 }, end: { x: 4, y: 396 } }))
    expect(r.kind).toBe('vertex')
    expect(r.end).toEqual({ x: 0, y: 400 })
  })

  it('does nothing outside the capture radius', () => {
    const r = solveAlignment(base({ index, cursor: { x: 30, y: 250 }, end: { x: 30, y: 250 } }))
    expect(r.kind).toBe('none')
    expect(r.end).toEqual({ x: 30, y: 250 })
  })

  it('radius is zoom-aware: 20 cm away captures when zoomed out 0.4x, not at 1x', () => {
    const cursor = { x: 20, y: 250 }
    expect(solveAlignment(base({ index, cursor, end: cursor, scale: 1 })).kind).toBe('none')
    expect(solveAlignment(base({ index, cursor, end: cursor, scale: 0.4 })).kind).toBe('guide')
    // zoomed far in the same 6 cm miss no longer captures
    expect(solveAlignment(base({ index, cursor: { x: 6, y: 250 }, end: { x: 6, y: 250 }, scale: 4 })).kind).toBe('none')
  })

  it('ignores the chain start itself and off-screen vertices', () => {
    const idx = buildAlignIndex([{ x: 500, y: 400 }, { x: 10, y: 9000 }])
    const cursor = { x: 503, y: 250 }
    expect(solveAlignment(base({ index: idx, cursor, end: cursor })).kind).toBe('none')
    const far = { x: 12, y: 250 }
    const bounds = { minX: -100, maxX: 1000, minY: -100, maxY: 1000 }
    expect(solveAlignment(base({ index: idx, cursor: far, end: far, bounds })).kind).toBe('none')
    expect(solveAlignment(base({ index: idx, cursor: far, end: far })).kind).toBe('guide')
  })
})

describe('solveAlignment — hysteresis', () => {
  const index = buildAlignIndex([{ x: 0, y: 0 }])
  it('holds a captured guide out to the release radius, but not a fresh one', () => {
    const cursor = { x: 11, y: 250 } // between capture (9) and release (13)
    expect(solveAlignment(base({ index, cursor, end: cursor })).kind).toBe('none')
    const held = solveAlignment(base({ index, cursor, end: cursor, prev: { x: 0, y: null } }))
    expect(held.kind).toBe('guide')
    expect(held.end.x).toBe(0)
    const gone = solveAlignment(base({ index, cursor: { x: 15, y: 250 }, end: { x: 15, y: 250 }, prev: { x: 0, y: null } }))
    expect(gone.kind).toBe('none')
  })
})

describe('solveAlignment — angle locks', () => {
  // Rectangle loop: start is (500,400) heading west to close onto x=0.
  const index = buildAlignIndex([{ x: 0, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 400 }])

  it('single guide slides along a locked axis ray and keeps the angle', () => {
    const r = solveAlignment(base({
      index,
      start: { x: 500, y: 400 },
      cursor: { x: 6, y: 402 },
      end: { x: 10, y: 400 },
      angleLock: 'axis',
      angleDeg: 180,
    }))
    expect(r.kind).toBe('guide')
    expect(r.end).toEqual({ x: 0, y: 400 })
  })

  it('a diagonal ray is slid onto the guide, staying on the ray', () => {
    const idx = buildAlignIndex([{ x: 300, y: -999 }])
    const start = { x: 0, y: 0 }
    const r = solveAlignment(base({
      index: idx,
      start,
      cursor: { x: 296, y: 296 },
      end: { x: 300, y: 300 },
      angleLock: 'diagonal',
      angleDeg: 45,
    }))
    expect(r.kind).toBe('guide')
    expect(r.end.x).toBe(300)
    expect(r.end.y).toBeCloseTo(300, 6)
  })

  it('ignores guides nearly parallel to the ray and ones behind the start', () => {
    const idx = buildAlignIndex([{ x: 502, y: -300 }])
    // vertical guide x=502 vs a vertical ray: |cos| ~ 0, no slide
    const r = solveAlignment(base({
      index: idx,
      start: { x: 500, y: 400 },
      cursor: { x: 500, y: 200 },
      end: { x: 500, y: 200 },
      angleLock: 'axis',
      angleDeg: -90,
    }))
    expect(r.kind).toBe('none')
    const behind = solveAlignment(base({
      index: buildAlignIndex([{ x: 505, y: 0 }]),
      start: { x: 500, y: 400 },
      cursor: { x: 495, y: 400 },
      end: { x: 495, y: 400 },
      angleLock: 'axis',
      angleDeg: 180,
    }))
    expect(behind.kind).toBe('none')
  })

  it('Shift hard lock: a guide may only slide along the ray, never take an intersection off it', () => {
    const idx = buildAlignIndex([{ x: 0, y: 0 }, { x: 40, y: 380 }])
    const r = solveAlignment(base({
      index: idx,
      start: { x: 500, y: 400 },
      cursor: { x: 41, y: 3 },
      end: { x: 42, y: 400 },
      angleLock: 'axis',
      angleDeg: 180,
      hard: true,
    }))
    expect(r.end.y).toBe(400)
  })

  it('two guides crossing beat an angle step in soft mode', () => {
    const idx = buildAlignIndex([{ x: 0, y: 300 }, { x: 250, y: 0 }])
    const r = solveAlignment(base({
      index: idx,
      start: { x: 100, y: 100 },
      cursor: { x: 248, y: 303 },
      end: { x: 250, y: 280 },
      angleLock: 'step',
      angleDeg: 75,
    }))
    expect(r.kind).toBe('intersection')
    expect(r.end).toEqual({ x: 250, y: 300 })
  })

  it('no vertices: untouched', () => {
    const e = { x: 3, y: 4 }
    const r = solveAlignment(base({ cursor: e, end: e }))
    expect(r.kind).toBe('none')
    expect(r.end).toBe(e)
  })
})

describe('solveAlignment — performance', () => {
  it('handles 2000 vertices well under a frame', () => {
    const pts = Array.from({ length: 2000 }, (_, i) => ({ x: (i * 37) % 5000, y: (i * 91) % 4000 }))
    const t0 = performance.now()
    for (let i = 0; i < 50; i++) {
      const idx = buildAlignIndex(pts)
      solveAlignment(base({ index: idx, cursor: { x: 1000 + i, y: 1000 }, end: { x: 1000 + i, y: 1000 } }))
    }
    expect((performance.now() - t0) / 50).toBeLessThan(5)
  })
})
