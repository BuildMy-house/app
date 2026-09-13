#!/usr/bin/env node
/**
 * export-scene.ts — Emit a RenderableScene JSON for a saved home.
 *
 * Loads a NormalizedHomeState JSON (as produced by `save`/`get_state`),
 * runs it through buildRenderableScene, and writes the platform-neutral
 * RenderableScene that LuxCoreRender consumes.
 *
 *   npm run export:scene -- path/to/home.json              # -> stdout
 *   npm run export:scene -- path/to/home.json -o scene.json
 */
import { readFileSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import type { NormalizedHomeState, CamerasState } from '../src/core/home'
import { buildRenderableScene } from '../src/render/scene-builder'

const DEFAULT_TOP_CAMERA: CamerasState['top'] = {
  id: 'camera-top-1',
  x: 50,
  y: 1050,
  z: 1010,
  yawDeg: 180,
  pitchDeg: 45,
  fovDeg: 63,
  lens: 'PINHOLE',
}

const DEFAULT_OBSERVER_CAMERA: CamerasState['observer'] = {
  id: 'camera-observer-1',
  x: 50,
  y: 50,
  z: 170,
  yawDeg: 315,
  pitchDeg: 11.25,
  fovDeg: 63,
  lens: 'PINHOLE',
  fixedSize: false,
}

function fail(message: string): never {
  console.error(`[export-scene] ERROR: ${message}`)
  process.exit(1)
}

function main(): void {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('-o')
  let input: string | undefined
  let output: string | undefined
  if (outIdx !== -1) {
    output = args[outIdx + 1]
    input = args.slice(0, outIdx).filter((a) => !a.startsWith('-'))[0]
  } else {
    input = args.find((a) => !a.startsWith('-'))
  }
  if (!input) fail('usage: export-scene <home.json> [-o output.json]')

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(input, 'utf8'))
  } catch (err) {
    fail(`cannot read ${input}: ${err instanceof Error ? err.message : String(err)}`)
  }

  const home = normalizeHome(raw)
  const { scene } = buildRenderableScene(home)
  const text = JSON.stringify(scene, null, 2)

  if (output) {
    writeFileSync(output, text)
    console.log(`[export-scene] wrote ${output} (${scene.objects.length} objects)`)
  } else {
    process.stdout.write(text)
  }
}

/** Default missing camera sub-objects to match createEmptyHome() shape. */
function normalizeCameras(raw: Partial<CamerasState> | undefined): CamerasState {
  return {
    top: { ...DEFAULT_TOP_CAMERA, ...(raw?.top ?? {}) },
    observer: { ...DEFAULT_OBSERVER_CAMERA, ...(raw?.observer ?? {}) },
  }
}

/** Fill in optional fields so a saved home (possibly missing env/compass) is usable. */
export function normalizeHome(raw: unknown): NormalizedHomeState {
  const h = (raw ?? {}) as Record<string, unknown>
  return {
    schemaVersion: 1 as const,
    name: typeof h.name === 'string' ? h.name : 'Untitled',
    levels: Array.isArray(h.levels) ? (h.levels as NormalizedHomeState['levels']) : [],
    walls: Array.isArray(h.walls) ? (h.walls as NormalizedHomeState['walls']) : [],
    rooms: Array.isArray(h.rooms) ? (h.rooms as NormalizedHomeState['rooms']) : [],
    furniture: Array.isArray(h.furniture) ? (h.furniture as NormalizedHomeState['furniture']) : [],
    dimensionLines: Array.isArray(h.dimensionLines) ? (h.dimensionLines as NormalizedHomeState['dimensionLines']) : [],
    labels: Array.isArray(h.labels) ? (h.labels as NormalizedHomeState['labels']) : [],
    roofs: Array.isArray(h.roofs) ? (h.roofs as NormalizedHomeState['roofs']) : [],
    selection: Array.isArray(h.selection) ? (h.selection as NormalizedHomeState['selection']) : [],
    cameras: normalizeCameras(h.cameras as Partial<CamerasState> | undefined),
    compass: (h.compass ?? null) as NormalizedHomeState['compass'],
    environment: (h.environment ?? {}) as NormalizedHomeState['environment'],
    activeTool: h.activeTool as NormalizedHomeState['activeTool'],
    capabilities: (h.capabilities ?? []) as NormalizedHomeState['capabilities'],
  }
}

if (process.argv[1]?.includes('export-scene')) main()
