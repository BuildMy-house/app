/**
 * scene-builder.ts — Converts NormalizedHomeState → RenderableScene.
 *
 * Produces a platform-neutral scene graph consumed by both Three.js
 * (real-time PBR with Lambert fallback) and LuxCoreRender (offline path-trace).
 */

import type {
  RenderableScene,
  MaterialDef,
  SceneObject,
  BoxPrimitive,
  PolygonPrimitive,
  CameraDef,
  LightDef,
} from './scene-graph'

import {
  DEFAULT_WALL_HEIGHT_CM,
  type NormalizedHomeState,
  type Wall,
  type Furniture,
} from '../core/home'

// ── Defaults ────────────────────────────────────────────────────

export const DEFAULT_WALL_COLOR = 0xd2d2d2
export const DEFAULT_FLOOR_COLOR = 0xc8c8c8
export const DEFAULT_FURNITURE_COLOR = 0x9e9e9e
export const DEFAULT_CEILING_COLOR = 0xf0f0f0

// ── Material factory ────────────────────────────────────────────

let _matId = 0
function makeMatId(): string {
  return `mat_${_matId++}`
}

function makeColorMaterial(color: number, shininess = 0): MaterialDef {
  return {
    id: makeMatId(),
    color,
    shininess,
    opacity: 1,
    model: 'standard',
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function levelElevationMap(home: NormalizedHomeState): Map<string, number> {
  const m = new Map<string, number>()
  for (const l of home.levels) m.set(l.id, l.elevation)
  return m
}

function elevationFor(ref: string | null | undefined, levels: Map<string, number>): number {
  if (ref == null) return 0
  return levels.get(ref) ?? 0
}

// ── Wall opening segmentation ──────────────────────────────────

interface WallOpening {
  /** Distance from wall start to opening center (cm) */
  centerAlong: number
  /** Opening width along the wall (cm) */
  width: number
  /** Bottom of opening above floor (cm) */
  bottom: number
  /** Top of opening above floor (cm) */
  top: number
}

function computeWallOpenings(
  wall: Wall,
  furniture: ReadonlyArray<Furniture>,
): WallOpening[] {
  const dx = wall.xEnd - wall.xStart
  const dy = wall.yEnd - wall.yStart
  const length = Math.hypot(dx, dy)
  if (length === 0) return []
  const openings: WallOpening[] = []
  for (const f of furniture) {
    if (!f.doorOrWindow || f.wallRef !== wall.id) continue
    let centerAlong: number
    if (f.wallOffset != null) {
      centerAlong = f.wallOffset
    } else {
      const t = ((f.x - wall.xStart) * dx + (f.y - wall.yStart) * dy) / (length * length)
      centerAlong = t * length
    }
    openings.push({
      centerAlong,
      width: f.width,
      bottom: f.elevation,
      top: f.elevation + f.height,
    })
  }
  return openings
}

function buildWallPrimitives(
  wall: Wall,
  openings: WallOpening[],
  wallHeight: number,
  wallElevation: number,
  angle: number,
  length: number,
  leftMatId: string,
  rightMatId: string,
): BoxPrimitive[] {
  const dx = wall.xEnd - wall.xStart
  const dy = wall.yEnd - wall.yStart
  const ux = dx / length
  const uy = dy / length
  const thickness = wall.thickness

  const segBox = (d1: number, d2: number, y1: number, y2: number, matId: string): BoxPrimitive => ({
    type: 'box',
    position: [wall.xStart + ux * (d1 + d2) / 2, wallElevation + (y1 + y2) / 2, wall.yStart + uy * (d1 + d2) / 2],
    size: [d2 - d1, y2 - y1, thickness],
    rotation: [0, -angle, 0],
    materialId: matId,
  })

  if (openings.length === 0) {
    const cx = (wall.xStart + wall.xEnd) / 2
    const cy = (wall.yStart + wall.yEnd) / 2
    return [
      { type: 'box', position: [cx, wallElevation + wallHeight / 2, cy], size: [length, wallHeight, thickness], rotation: [0, -angle, 0], materialId: rightMatId },
      { type: 'box', position: [cx, wallElevation + wallHeight / 2, cy], size: [length, wallHeight, thickness], rotation: [0, -angle, 0], materialId: leftMatId },
    ]
  }

  const sorted = [...openings].sort((a, b) => (a.centerAlong - a.width / 2) - (b.centerAlong - b.width / 2))
  const boxes: BoxPrimitive[] = []
  let pos = 0
  for (const op of sorted) {
    const opStart = Math.max(0, op.centerAlong - op.width / 2)
    const opEnd = Math.min(length, op.centerAlong + op.width / 2)
    if (opStart > pos) {
      boxes.push(segBox(pos, opStart, 0, wallHeight, rightMatId))
      boxes.push(segBox(pos, opStart, 0, wallHeight, leftMatId))
    }
    if (op.bottom > 0) {
      boxes.push(segBox(opStart, opEnd, 0, op.bottom, rightMatId))
      boxes.push(segBox(opStart, opEnd, 0, op.bottom, leftMatId))
    }
    if (op.top < wallHeight) {
      boxes.push(segBox(opStart, opEnd, op.top, wallHeight, rightMatId))
      boxes.push(segBox(opStart, opEnd, op.top, wallHeight, leftMatId))
    }
    pos = Math.max(pos, opEnd)
  }
  if (pos < length) {
    boxes.push(segBox(pos, length, 0, wallHeight, rightMatId))
    boxes.push(segBox(pos, length, 0, wallHeight, leftMatId))
  }
  return boxes
}

// ── Build function ──────────────────────────────────────────────

export interface SceneBuilderResult {
  scene: RenderableScene
  materialMap: Map<string, MaterialDef>
}

/**
 * Build a RenderableScene from a normalized home state.
 *
 * @param home - The normalized home state
 * @param sceneName - Name for the scene (defaults to home.name)
 * @returns The RenderableScene and a material lookup map
 */
export function buildRenderableScene(
  home: NormalizedHomeState,
  sceneName?: string,
): SceneBuilderResult {
  _matId = 0

  const materials: MaterialDef[] = []
  const materialMap = new Map<string, MaterialDef>()
  const objects: SceneObject[] = []

  const elevations = levelElevationMap(home)
  const _wallsTransparency = home.environment.wallsAlpha ?? 0

  // ── Camera ──────────────────────────────────────────────────

  const cam = home.cameras.observer
  const camera: CameraDef = {
    position: [cam.x, cam.z, cam.y], // SH3D plan→3D mapping
    yaw: degToRad(180 - cam.yawDeg),
    pitch: degToRad(-cam.pitchDeg),
    fov: cam.fovDeg,
    projection: 'perspective',
  }

  // ── Lights ──────────────────────────────────────────────────

  const lightColor = home.environment.lightColor ?? 0xffffff
  const lights: LightDef[] = [
    // Ambient approximation via directional
    {
      id: 'light_ambient',
      type: 'directional',
      direction: [0.5, 1, 0.35],
      intensity: 0.55,
      color: lightColor,
    },
    {
      id: 'light_key',
      type: 'directional',
      direction: [0.5, 1, 0.35],
      intensity: 0.9,
      color: lightColor,
    },
  ]

  // ── Background ──────────────────────────────────────────────

  const backgroundColor = home.environment.skyColor ?? 0xcce4fc

  // ── Walls ───────────────────────────────────────────────────

  for (const wall of home.walls) {
    const elevation = elevationFor(wall.levelRef, elevations)
    const leftColor = wall.leftSideColor ?? DEFAULT_WALL_COLOR
    const rightColor = wall.rightSideColor ?? wall.leftSideColor ?? DEFAULT_WALL_COLOR

    const leftMat = makeColorMaterial(leftColor)
    const rightMat = makeColorMaterial(rightColor)
    materials.push(leftMat, rightMat)

    const dx = wall.xEnd - wall.xStart
    const dy = wall.yEnd - wall.yStart
    const length = Math.hypot(dx, dy)
    const height = wall.height ?? DEFAULT_WALL_HEIGHT_CM
    const angle = Math.atan2(dy, dx)

    const openings = computeWallOpenings(wall, home.furniture)
    const primitives = buildWallPrimitives(
      wall, openings, height, elevation, angle, length, leftMat.id, rightMat.id,
    )

    const wallObj: SceneObject = {
      id: `wall:${wall.id}`,
      name: `Wall ${wall.id}`,
      primitives,
      visible: { plan: true, threeD: true, luxcore: true },
    }
    objects.push(wallObj)
  }

  // ── Rooms ───────────────────────────────────────────────────

  for (const room of home.rooms) {
    if (room.points.length < 3) continue
    const elevation = elevationFor(room.levelRef, elevations)

    const floorColor = room.floorColor ?? DEFAULT_FLOOR_COLOR
    const floorMat = makeColorMaterial(floorColor)
    materials.push(floorMat)

    const floorPoly: PolygonPrimitive = {
      type: 'polygon',
      vertices: room.points.map(([x, y]) => [x, y]),
      y: elevation,
      height: 0,
      materialId: floorMat.id,
    }

    const roomObj: SceneObject = {
      id: `room:${room.id}`,
      name: room.name || `Room ${room.id}`,
      primitives: [floorPoly],
      visible: {
        plan: room.floorVisible !== false,
        threeD: room.floorVisible !== false,
        luxcore: true,
      },
    }
    objects.push(roomObj)

    // Ceiling
    if (room.ceilingVisible !== false) {
      const ceilingMat = makeColorMaterial(DEFAULT_CEILING_COLOR)
      materials.push(ceilingMat)

      const level = home.levels.find(l => l.id === room.levelRef)
      const ceilingHeight = level ? level.height : DEFAULT_WALL_HEIGHT_CM

      const ceilingPoly: PolygonPrimitive = {
        type: 'polygon',
        vertices: room.points.map(([x, y]) => [x, y]),
        y: elevation + ceilingHeight,
        height: 0,
        materialId: ceilingMat.id,
      }

      const ceilingObj: SceneObject = {
        id: `ceiling:${room.id}`,
        name: `Ceiling ${room.name || room.id}`,
        primitives: [ceilingPoly],
        visible: { plan: false, threeD: true, luxcore: true },
      }
      objects.push(ceilingObj)
    }
  }

  // ── Furniture ───────────────────────────────────────────────

  for (const item of home.furniture) {
    if (item.visible === false) continue
    const elevation = elevationFor(item.levelRef, elevations)
    const color = item.color ?? DEFAULT_FURNITURE_COLOR
    const mat = makeColorMaterial(color)
    materials.push(mat)

    const box: BoxPrimitive = {
      type: 'box',
      position: [item.x, elevation + item.elevation + item.height / 2, item.y],
      size: [item.width, item.height, item.depth],
      rotation: [0, -degToRad(item.angleDeg), 0],
      materialId: mat.id,
    }

    const obj: SceneObject = {
      id: `furniture:${item.id}`,
      name: item.name,
      primitives: [box],
      visible: { plan: true, threeD: true, luxcore: true },
    }
    objects.push(obj)
  }

  return {
    scene: {
      version: 1,
      name: sceneName ?? home.name ?? 'Untitled',
      textures: [],
      materials,
      objects,
      camera,
      lights,
      backgroundColor,
    },
    materialMap,
  }
}

// ── Utility ─────────────────────────────────────────────────────

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180
}
