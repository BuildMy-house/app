/**
 * Compile scripts/templates/defs into the files the app and marketing site
 * consume: public/templates/<id>.json (plan), <id>.svg (floor-plan drawing) and
 * index.json (summaries). `--check` fails if the committed files are stale.
 * `--site <dir>` also copies index.json + drawings into the website checkout.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { compileTemplate, type TemplateDef } from './templates/dsl'
import { planSvg } from './templates/svg'
import { TEMPLATES } from './templates/defs'
import type { TemplatePlan, TemplateSummary } from '../src/templates/types'

const OUT = resolve(import.meta.dirname, '../public/templates')

const area = (points: Array<[number, number]>) => {
  let sum = 0
  points.forEach(([x, y], i) => {
    const [nx, ny] = points[(i + 1) % points.length]!
    sum += x * ny - nx * y
  })
  return Math.abs(sum) / 2
}
const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places

export function summarize(def: TemplateDef, plan: TemplatePlan, meta: ReturnType<typeof compileTemplate>['rooms']): TemplateSummary {
  const xs = plan.walls.flatMap((w) => [w.xStart - w.thickness / 2, w.xEnd + w.thickness / 2])
  const ys = plan.walls.flatMap((w) => [w.yStart - w.thickness / 2, w.yEnd + w.thickness / 2])
  const bounds = (pts: Array<[number, number]>) => ({
    w: Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0])),
    d: Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])),
  })
  const rooms = plan.rooms.map((room, i) => {
    const b = bounds(room.points)
    return { name: room.name, widthCm: Math.round(b.w), depthCm: Math.round(b.d), areaM2: round(area(room.points) / 10000, 1), outdoor: meta[i]!.outdoor }
  })
  return {
    id: def.id,
    name: def.name,
    category: def.category,
    description: def.description,
    widthCm: Math.round(Math.max(...xs) - Math.min(...xs)),
    depthCm: Math.round(Math.max(...ys) - Math.min(...ys)),
    areaM2: round(rooms.filter((r) => !r.outdoor).reduce((sum, r) => sum + r.areaM2, 0), 1),
    bedrooms: meta.filter((r) => r.kind === 'bedroom').length,
    bathrooms: meta.filter((r) => r.kind === 'bath').length,
    rooms,
    furnitureCount: plan.furniture.length,
    features: def.features,
  }
}

export function buildAll(): Map<string, string> {
  const files = new Map<string, string>()
  const summaries: TemplateSummary[] = []
  for (const def of TEMPLATES) {
    const { plan, inward, rooms } = compileTemplate(def)
    files.set(`${def.id}.json`, `${JSON.stringify(plan, null, 1)}\n`)
    files.set(`${def.id}.svg`, planSvg(plan, inward))
    summaries.push(summarize(def, plan, rooms))
  }
  files.set('index.json', `${JSON.stringify({ schemaVersion: 1, templates: summaries }, null, 1)}\n`)
  return files
}

function main(): void {
  const args = process.argv.slice(2)
  const files = buildAll()
  if (args.includes('--check')) {
    const stale = [...files].filter(([name, text]) => !existsSync(join(OUT, name)) || readFileSync(join(OUT, name), 'utf8') !== text).map(([name]) => name)
    const orphans = existsSync(OUT) ? readdirSync(OUT).filter((n) => !files.has(n)) : []
    if (stale.length || orphans.length) {
      console.error(`templates out of date (run \`npm run templates\`): stale=${stale.join(',')} orphans=${orphans.join(',')}`)
      process.exit(1)
    }
    console.log(`templates up to date (${TEMPLATES.length})`)
    return
  }
  mkdirSync(OUT, { recursive: true })
  for (const n of existsSync(OUT) ? readdirSync(OUT) : []) if (!files.has(n)) throw new Error(`orphan ${n} in public/templates — delete it`)
  for (const [name, text] of files) writeFileSync(join(OUT, name), text)
  const siteIdx = args.indexOf('--site')
  if (siteIdx >= 0) {
    const site = resolve(args[siteIdx + 1]!)
    mkdirSync(join(site, 'public/templates'), { recursive: true })
    mkdirSync(join(site, 'src/data'), { recursive: true })
    for (const [name] of files) {
      if (name.endsWith('.svg')) copyFileSync(join(OUT, name), join(site, 'public/templates', name))
    }
    copyFileSync(join(OUT, 'index.json'), join(site, 'src/data/templates.json'))
  }
  console.log(`wrote ${files.size} files to ${OUT}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
