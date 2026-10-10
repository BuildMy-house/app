import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { catalogFromManifest } from '../src/core/catalog-service'
import type { CatalogManifest } from '../src/core/catalog'
import catalogJsonRaw from '../assets/catalog/catalog.json'
import { buildHomeFromTemplate } from '../src/templates/apply'
import { searchWithoutTemplate, templateIdFromSearch } from '../src/templates/load'
import type { TemplateFurniture } from '../src/templates/types'
import { TEMPLATES } from '../scripts/templates/defs'
import { compileTemplate } from '../scripts/templates/dsl'
import { buildAll } from '../scripts/build-templates'

const catalog = catalogFromManifest(catalogJsonRaw as unknown as CatalogManifest)
const compiled = TEMPLATES.map((def) => ({ def, ...compileTemplate(def) }))

type Pt = [number, number]

function corners(f: { x: number; y: number; width: number; depth: number; angleDeg: number }, shrink = 0): Pt[] {
  const a = (f.angleDeg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const hw = f.width / 2 - shrink
  const hd = f.depth / 2 - shrink
  return ([[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] as Pt[]).map(([px, py]) => [f.x + px * c - py * s, f.y + px * s + py * c])
}

function overlaps(a: Pt[], b: Pt[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = poly[i]!
      const [x2, y2] = poly[(i + 1) % 4]!
      const nx = y1 - y2
      const ny = x2 - x1
      const proj = (p: Pt[]) => p.map(([x, y]) => x * nx + y * ny)
      const pa = proj(a)
      const pb = proj(b)
      if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false
    }
  }
  return true
}

const floorStanding = (f: TemplateFurniture) => f.elevation < 30 && f.height > 3

describe('template catalog', () => {
  it('states only floor areas that match the computed plan', () => {
    const index = JSON.parse(buildAll().get('index.json')!) as { templates: Array<{ id: string; description: string; areaM2: number }> }
    for (const t of index.templates) {
      for (const [, n] of t.description.matchAll(/([\d,.]+) m2/g)) expect(Number(n!.replace(/,/g, '')), `${t.id} m2`).toBeCloseTo(t.areaM2, -0.5)
      for (const [, n] of t.description.matchAll(/([\d,.]+) sq ft/g)) {
        expect(Math.abs(Number(n!.replace(/,/g, '')) / (t.areaM2 * 10.764) - 1), `${t.id} sq ft`).toBeLessThan(0.04)
      }
    }
  })

  it('ships 20 templates with unique kebab-case ids', () => {
    expect(TEMPLATES.length).toBe(20)
    const ids = TEMPLATES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(templateIdFromSearch(`?template=${id}`)).toBe(id)
  })

  it('generated files in public/templates are up to date', () => {
    for (const [name, text] of buildAll()) {
      expect(readFileSync(join(__dirname, '../public/templates', name), 'utf8'), name).toBe(text)
    }
  })
})

describe.each(compiled)('template $def.id', ({ def, plan }) => {
  const roomBox = plan.rooms.map((r) => ({
    name: r.name,
    x1: Math.min(...r.points.map((p) => p[0])),
    x2: Math.max(...r.points.map((p) => p[0])),
    y1: Math.min(...r.points.map((p) => p[1])),
    y2: Math.max(...r.points.map((p) => p[1])),
  }))

  it('references only real catalog items and builds a home', () => {
    for (const item of [...plan.furniture, ...plan.openings]) {
      if (item.catalogId) expect(catalog.get(item.catalogId), `${item.name}: ${item.catalogId}`).toBeDefined()
    }
    const home = buildHomeFromTemplate(plan, catalog)
    expect(home.walls.length).toBe(plan.walls.length)
    expect(home.rooms.length).toBe(plan.rooms.length)
    expect(home.furniture.length).toBe(plan.furniture.length + plan.openings.length)
    expect(home.name).toBe(plan.name)
    // Still opens (as plain boxes) with no catalog loaded.
    expect(buildHomeFromTemplate(plan, null).furniture.length).toBe(home.furniture.length)
  })

  it('has doors, windows, and enough furniture to be a usable start', () => {
    expect(plan.openings.some((o) => o.kind === 'door')).toBe(true)
    expect(plan.openings.some((o) => o.kind === 'window')).toBe(true)
    expect(plan.furniture.length).toBeGreaterThanOrEqual(def.category === 'Single rooms' ? 5 : 12)
  })

  it('rooms do not overlap each other', () => {
    for (const a of roomBox) {
      for (const b of roomBox) {
        if (a === b) continue
        const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)
        const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1)
        expect(w > 0.5 && h > 0.5, `${a.name} overlaps ${b.name}`).toBe(false)
      }
    }
  })

  it('openings sit inside their wall and do not collide', () => {
    const byWall = new Map<string, Array<[number, number, string]>>()
    for (const o of plan.openings) {
      const wall = plan.walls.find((w) => w.key === o.wallKey)!
      const len = Math.hypot(wall.xEnd - wall.xStart, wall.yEnd - wall.yStart)
      expect(o.offset - o.width / 2, `${o.name} start`).toBeGreaterThanOrEqual(0)
      expect(o.offset + o.width / 2, `${o.name} end`).toBeLessThanOrEqual(len)
      byWall.set(o.wallKey, [...(byWall.get(o.wallKey) ?? []), [o.offset - o.width / 2, o.offset + o.width / 2, o.name]])
    }
    for (const spans of byWall.values()) {
      spans.sort((a, b) => a[0] - b[0])
      spans.slice(1).forEach((s, i) => expect(s[0], `${spans[i]![2]} vs ${s[2]}`).toBeGreaterThanOrEqual(spans[i]![1] + 20))
    }
  })

  it('keeps every piece inside a room', () => {
    for (const f of plan.furniture) {
      const room = roomBox.find((r) => f.x >= r.x1 && f.x <= r.x2 && f.y >= r.y1 && f.y <= r.y2)
      expect(room, `${f.name} at ${f.x},${f.y} is outside every room`).toBeDefined()
      for (const [x, y] of corners(f)) {
        expect(x, `${f.name} x`).toBeGreaterThanOrEqual(room!.x1 - 1)
        expect(x, `${f.name} x`).toBeLessThanOrEqual(room!.x2 + 1)
        expect(y, `${f.name} y`).toBeGreaterThanOrEqual(room!.y1 - 1)
        expect(y, `${f.name} y`).toBeLessThanOrEqual(room!.y2 + 1)
      }
    }
  })

  it('has no overlapping floor-standing furniture', () => {
    const items = plan.furniture.filter(floorStanding)
    items.forEach((a, i) => {
      items.slice(i + 1).forEach((b) => {
        expect(overlaps(corners(a, 1), corners(b, 1)), `${a.name}@${a.x},${a.y} overlaps ${b.name}@${b.x},${b.y}`).toBe(false)
      })
    })
  })

  it('keeps door landings clear on both sides', () => {
    for (const o of plan.openings.filter((x) => x.kind === 'door')) {
      const wall = plan.walls.find((w) => w.key === o.wallKey)!
      const horizontal = wall.yStart === wall.yEnd
      const along = (horizontal ? Math.min(wall.xStart, wall.xEnd) : Math.min(wall.yStart, wall.yEnd)) + o.offset
      const reach = 70
      for (const side of [-1, 1]) {
        const zone = horizontal
          ? { x: along, y: wall.yStart + side * (wall.thickness / 2 + reach / 2), width: Math.min(o.width, 90), depth: reach, angleDeg: 0 }
          : { x: wall.xStart + side * (wall.thickness / 2 + reach / 2), y: along, width: reach, depth: Math.min(o.width, 90), angleDeg: 0 }
        for (const f of plan.furniture.filter(floorStanding)) {
          expect(overlaps(corners(zone), corners(f, 1)), `${f.name}@${f.x},${f.y} blocks ${o.name} landing`).toBe(false)
        }
      }
    }
  })
})

describe('template URL handling', () => {
  it('accepts only well-formed ids', () => {
    expect(templateIdFromSearch('?template=3-bedroom-ranch')).toBe('3-bedroom-ranch')
    expect(templateIdFromSearch('')).toBeNull()
    expect(templateIdFromSearch('?template=../etc/passwd')).toBeNull()
    expect(templateIdFromSearch('?template=A_B')).toBeNull()
  })
  it('strips only the template param', () => {
    expect(searchWithoutTemplate('?template=x&port=9')).toBe('?port=9')
    expect(searchWithoutTemplate('?template=x')).toBe('')
  })
})

