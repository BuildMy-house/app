/**
 * scene-delta-parity.test.ts — Cross-path parity regression tests.
 *
 * scene.ts (full rebuild) and scene-delta.ts (incremental updates)
 * historically drifted apart on elevation-relative rendering rules (the
 * below-level wall z-fight of c9f277e was fixed in one path only). These
 * tests build the SAME home through both paths and assert identical mesh
 * presence, ghost offsets (position.y), and opacity/transparency for every
 * mesh type × elevation condition × view mode.
 *
 * Lives in its own file to keep the parity matrix (and its fixture helpers)
 * separate from scene.test.ts's per-feature suites.
 */
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createEmptyHome, type NormalizedHomeState } from '../core/home'
import { buildScene } from './scene'
import { applySceneUpdate, computeSceneUpdates } from './scene-delta'

function makeHome(levelRef: string): NormalizedHomeState {
  const home = createEmptyHome()
  home.levels.push(
    { id: 'level-g', name: 'Ground', elevation: 0, floorThickness: 5, height: 250, visible: true, viewable: true },
    { id: 'level-m', name: 'Middle', elevation: 250, floorThickness: 5, height: 250, visible: true, viewable: true },
    { id: 'level-t', name: 'Top', elevation: 500, floorThickness: 5, height: 250, visible: true, viewable: true },
  )
  home.walls.push({ id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15, levelRef })
  home.rooms.push({ id: 'r1', points: [[0, 0], [400, 0], [400, 200], [0, 200]], levelRef })
  return home
}

/** Same ids, nudged geometry — so computeSceneUpdates emits wall/room updates. */
function previousState(home: NormalizedHomeState): NormalizedHomeState {
  const old = structuredClone(home)
  const wall = old.walls[0]!
  wall.xEnd = 380
  const room = old.rooms[0]!
  room.points = [[0, 0], [380, 0], [380, 200], [0, 200]]
  return old
}

const ELEVATION_CASES = [
  { name: 'active top level (no level above)', activeLevel: 'level-t', levelRef: 'level-t' },
  { name: 'active middle level', activeLevel: 'level-m', levelRef: 'level-m' },
  { name: 'directly below active', activeLevel: 'level-t', levelRef: 'level-m' },
  { name: 'directly below active middle', activeLevel: 'level-m', levelRef: 'level-g' },
  { name: 'two levels below active (non-adjacent)', activeLevel: 'level-t', levelRef: 'level-g' },
  { name: 'above active', activeLevel: 'level-m', levelRef: 'level-t' },
]

const MESH_NAMES = ['wall:w1', 'wall-edge:w1', 'room:r1', 'ceiling:r1']

function findNamed(scene: THREE.Object3D, name: string): THREE.Object3D[] {
  const found: THREE.Object3D[] = []
  scene.traverse((o) => {
    if (o.name === name) found.push(o)
  })
  return found
}

/** Presence + ghost offset + opacity/transparency in one comparable value. */
function fingerprint(scene: THREE.Scene, name: string): string | null {
  const found = findNamed(scene, name)
  if (found.length === 0) return null
  const mesh = found[0] as THREE.Mesh
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  const opacities = materials.map((m) => (m as THREE.MeshStandardMaterial).opacity)
  return JSON.stringify({ y: mesh.position.y, opacities })
}

function expectParity(
  home: NormalizedHomeState,
  old: NormalizedHomeState,
  activeLevel: string,
  isOutsideView: boolean,
): void {
  const opts = { activeLevel, isOutsideView }
  const full = buildScene(home, opts)
  const delta = buildScene(old, opts)
  const updates = computeSceneUpdates(old, home)
  expect(updates.length).toBeGreaterThan(0)
  for (const update of updates) {
    expect(applySceneUpdate(delta, update, home, old, opts), update.type).toBe(true)
  }
  for (const name of MESH_NAMES) {
    expect(fingerprint(delta, name), `${name} via ${updateTypes(updates)}`).toBe(
      fingerprint(full, name),
    )
  }
}

function updateTypes(updates: ReturnType<typeof computeSceneUpdates>): string {
  return updates.map((u) => u.type).join('+')
}

describe('scene vs scene-delta elevation parity', () => {
  for (const isOutsideView of [false, true]) {
    describe(`isOutsideView=${isOutsideView}`, () => {
      for (const c of ELEVATION_CASES) {
        it(`wall + floor + ceiling agree: ${c.name}`, () => {
          const home = makeHome(c.levelRef)
          expectParity(home, previousState(home), c.activeLevel, isOutsideView)
        })
      }
    })
  }
})

describe('roof changes fall back to full rebuild', () => {
  const ROOF = {
    id: 'roof-1',
    points: [[0, 0], [400, 0], [400, 200], [0, 200]] as Array<[number, number]>,
    levelRef: 'level-t',
    style: 'gable' as const,
    pitchDeg: 30,
    overhangCm: 20,
  }

  it('roof edit alone → full rebuild', () => {
    const home = makeHome('level-t')
    home.roofs.push({ ...ROOF })
    expect(computeSceneUpdates(makeHome('level-t'), home)).toEqual([
      { type: 'full-rebuild', reason: 'roof change detected' },
    ])
  })

  it('roof field change → full rebuild', () => {
    const home = makeHome('level-t')
    home.roofs.push({ ...ROOF })
    const old = structuredClone(home)
    old.roofs[0]!.pitchDeg = 20
    expect(computeSceneUpdates(old, home)).toEqual([
      { type: 'full-rebuild', reason: 'roof change detected' },
    ])
  })

  it('roof edit bundled with a wall edit → full rebuild, not a silently dropped roof', () => {
    const home = makeHome('level-t')
    home.roofs.push({ ...ROOF })
    const old = structuredClone(home)
    old.roofs.length = 0
    old.walls[0]!.xEnd = 380
    expect(computeSceneUpdates(old, home)).toEqual([
      { type: 'full-rebuild', reason: 'roof change detected' },
    ])
  })
})
