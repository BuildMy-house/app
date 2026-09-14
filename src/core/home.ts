/**
 * Normalized home state (schemaVersion 1) mirroring docs/schema/home-project.schema.json.
 * Lengths are centimeters, angles degrees normalized to (-180, 180] unless suffixed
 * otherwise (arcExtent stays radians, latitudeRad/longitudeRad radians).
 */

import { compassRadiansForZone, resolveTimezone } from './compass-timezones'

export const SCHEMA_VERSION = 1

/** Default wall height in cm (SH3D UserPreferences default). */
export const DEFAULT_WALL_HEIGHT_CM = 250

/** Stable export ids for the two SH3D cameras (driver IdAssigner parity). */
export const TOP_CAMERA_ID = 'camera-top-1'
export const OBSERVER_CAMERA_ID = 'camera-observer-1'

export type LensName = 'PINHOLE' | 'NORMAL' | 'FISHEYE' | 'SPHERICAL'

export type ActiveTool =
  | null
  | 'selection'
  | 'panning'
  | 'wall'
  | 'room'
  | 'polyline'
  | 'dimensionLine'
  | 'label'
  | 'roof'

export interface Level {
  id: string
  name: string
  elevation: number
  floorThickness: number
  height: number
  visible: boolean
  viewable: boolean
}

/**
 * One entry of the shared wall/ground/furniture texture catalog.
 * Base fields are the original catalog shape; the PBR fields (MAT-T2) are
 * optional additions so existing consumers keep working unchanged.
 */
export interface WallTextureEntry {
  id: string
  label: string
  /** Diffuse/base-color map file, relative to `assets/textures/` (sRGB). */
  file: string
  /** Linear-space PBR maps (NOT sRGB), relative to `assets/textures/`. */
  normalFile?: string
  roughnessFile?: string
  metalnessFile?: string
  aoFile?: string
  /** Scalar PBR defaults applied wherever this texture is used. */
  roughness?: number
  metalness?: number
}

/**
 * Scalar choices (MAT-T2, all dielectrics → metalness 0):
 * - carpet 0.95 — fibrous pile, fully matte
 * - concrete 0.90 — raw cement, near-matte
 * - plaster-white 0.90 — matte painted wall
 * - tile-floor 0.35 — glazed ceramic, semi-gloss
 * - wood-oak 0.65 — varnished hardwood (normal/roughness/AO maps ship too)
 * - wood-pine 0.70 — raw-ish softwood, slightly duller than oak
 */
export const WALL_TEXTURES: WallTextureEntry[] = [
  { id: 'carpet', label: 'Carpet', file: 'carpet.png', roughness: 0.95, metalness: 0 },
  { id: 'concrete', label: 'Concrete', file: 'concrete.png', roughness: 0.9, metalness: 0 },
  { id: 'plaster-white', label: 'Plaster White', file: 'plaster-white.png', roughness: 0.9, metalness: 0 },
  { id: 'tile-floor', label: 'Tile Floor', file: 'tile-floor.png', roughness: 0.35, metalness: 0 },
  {
    id: 'wood-oak',
    label: 'Wood Oak',
    file: 'wood-oak.png',
    normalFile: 'wood-oak_normal.png',
    roughnessFile: 'wood-oak_roughness.png',
    aoFile: 'wood-oak_ao.png',
    roughness: 0.65,
    metalness: 0,
  },
  { id: 'wood-pine', label: 'Wood Pine', file: 'wood-pine.png', roughness: 0.7, metalness: 0 },
]

export type WallTextureId = (typeof WALL_TEXTURES)[number]['id']

export interface Wall {
  id: string
  xStart: number
  yStart: number
  xEnd: number
  yEnd: number
  thickness: number
  /** Radians, positive = counterclockwise bulge. Absent/null for straight walls. */
  arcExtent?: number | null
  height?: number | null
  heightAtEnd?: number | null
  levelRef?: string | null
  leftSideColor?: number | null
  rightSideColor?: number | null
  leftSideTextureId?: string | null
  rightSideTextureId?: string | null
  patternId?: string | null
}

export interface Room {
  id: string
  points: Array<[number, number]>
  name?: string | null
  areaVisible?: boolean
  floorVisible?: boolean
  floorColor?: number | null
  ceilingVisible?: boolean
  levelRef?: string | null
}

export interface Polyline {
  id: string
  points: Array<[number, number]>
  closed: boolean
  name?: string | null
  color?: number | null
  thickness?: number | null
  levelRef?: string | null
}

export interface Furniture {
  id: string
  name: string
  x: number
  y: number
  angleDeg: number
  width: number
  depth: number
  height: number
  elevation: number
  catalogId?: string | null
  pitchDeg?: number
  rollDeg?: number
  color?: number | null
  textureId?: string | null
  visible?: boolean
  movable?: boolean
  doorOrWindow?: boolean
  wallRef?: string | null
  wallOffset?: number | null
  /** Up to three [xDeg, yDeg, zDeg] rotation triples (schema modelRotationDeg). */
  modelRotationDeg?: Array<[number, number, number]>
  /**
   * Optional 3D model asset path, relative to `public/assets/`
   * (e.g. "models/sofa.glb"). When present the 3D view swaps the colored
   * box for this loaded model. Absent/empty => colored box (backward compat).
   */
  modelPath?: string | null
  levelRef?: string | null
  modelMirrored?: boolean
}

export interface DimensionLine {
  id: string
  xStart: number
  yStart: number
  xEnd: number
  yEnd: number
  offset: number
  elevationStart?: number
  elevationEnd?: number
  levelRef?: string | null
}

export interface Label {
  id: string
  text: string
  x: number
  y: number
  angleDeg?: number
  elevation?: number
  color?: number | null
  levelRef?: string | null
}

export interface Roof {
  id: string
  points: Array<[number, number]>
  name?: string | null
  color?: number | null
  levelRef?: string | null
  style: 'gable' | 'hip'
  pitchDeg: number
  overhangCm: number
  ridgeAngleDeg?: number | null
}

export interface CameraState {
  id?: string
  x: number
  y: number
  z: number
  yawDeg: number
  pitchDeg: number
  fovDeg: number
  lens: LensName
}

export interface ObserverCameraState extends CameraState {
  fixedSize?: boolean
}

export interface CamerasState {
  top: CameraState
  observer: ObserverCameraState
}

export interface CompassState {
  x: number
  y: number
  diameter: number
  northDirectionDeg: number
  latitudeRad: number
  longitudeRad: number
  visible: boolean
}

export interface EnvironmentState {
  skyColor: number | null
  groundColor: number | null
  lightColor: number | null
  /** SH3D walls TRANSPARENCY: 0 = opaque (default), 1 = invisible. */
  wallsAlpha: number | null
  groundTextureId?: string | null
}

export interface HomePreferences {
  defaultFloorColor: number
  defaultFloorShininess: number
  defaultCeilingColor: number
  defaultCeilingVisibility: boolean
}

/** Ground textures reuse the same PNG catalog as walls (SH3D parity). */
export const GROUND_TEXTURES = WALL_TEXTURES

export interface CapabilitiesState {
  canUndo: boolean
  canRedo: boolean
}

export interface NormalizedHomeState {
  schemaVersion: typeof SCHEMA_VERSION
  name?: string
  levels: Level[]
  walls: Wall[]
  rooms: Room[]
  polylines: Polyline[]
  furniture: Furniture[]
  dimensionLines: DimensionLine[]
  labels: Label[]
  roofs: Roof[]
  selection: string[]
  cameras: CamerasState
  compass: CompassState
  environment: EnvironmentState
  preferences?: HomePreferences
  activeTool: ActiveTool
  capabilities: CapabilitiesState
}

/**
 * A truly empty Sweet Home 3D 7.5 home: no levels (created on demand),
 * default top/observer cameras, visible compass at (-100, 50) d=100 located
 * at the OS timezone's coordinates (Compass.initGeographicPoint parity,
 * docs/behaviours/sh3d-camera-and-export.md §3), gray ground / blue sky /
 * light-gray light, fully opaque walls (wallsAlpha transparency 0).
 *
 * timeZoneId is injectable for deterministic tests; omitted = OS zone via
 * Intl, unknown zones fall back to the SH3D Etc/GMT entry.
 */
export function createEmptyHome(timeZoneId?: string | null): NormalizedHomeState {
  const { latitudeRad, longitudeRad } = compassRadiansForZone(
    timeZoneId === undefined ? resolveTimezone() : timeZoneId,
  )
  return {
    schemaVersion: SCHEMA_VERSION,
    levels: [],
    walls: [],
    rooms: [],
    polylines: [],
    furniture: [],
    dimensionLines: [],
    labels: [],
    roofs: [],
    selection: [],
    cameras: {
      top: {
        id: TOP_CAMERA_ID,
        x: 50,
        y: 1050,
        z: 1010,
        yawDeg: 180,
        pitchDeg: 45,
        fovDeg: 63,
        lens: 'PINHOLE',
      },
      observer: {
        id: OBSERVER_CAMERA_ID,
        x: 50,
        y: 50,
        z: 170,
        yawDeg: 315,
        pitchDeg: 11.25,
        fovDeg: 63,
        lens: 'PINHOLE',
        fixedSize: false,
      },
    },
    compass: {
      x: -100,
      y: 50,
      diameter: 100,
      northDirectionDeg: 0,
      latitudeRad,
      longitudeRad,
      visible: true,
    },
    environment: {
      skyColor: 0xcce4fc,
      groundColor: 0xa8a8a8,
      lightColor: 0xd0d0d0,
      wallsAlpha: 0,
    },
    preferences: {
      defaultFloorColor: 0xf0f0f0,
      defaultFloorShininess: 0,
      defaultCeilingColor: 0xffffff,
      defaultCeilingVisibility: true,
    },
    activeTool: null,
    capabilities: { canUndo: false, canRedo: false },
  }
}

/** Compute the elevation for the next level to add above the existing ones.
 *  Ground floor is implicit (not in levels[]), so the first added level sits
 *  at DEFAULT_WALL_HEIGHT_CM; subsequent levels stack at the top of the
 *  highest existing level. */
export function nextLevelElevation(levels: ReadonlyArray<Level>): number {
  if (levels.length === 0) return DEFAULT_WALL_HEIGHT_CM
  return Math.max(...levels.map((l) => l.elevation + l.height))
}

export function getDefaultFloorColor(home: NormalizedHomeState): number {
  return home.preferences?.defaultFloorColor ?? 0xf0f0f0
}

export function getDefaultFloorShininess(home: NormalizedHomeState): number {
  return home.preferences?.defaultFloorShininess ?? 0
}

export function getDefaultCeilingColor(home: NormalizedHomeState): number {
  return home.preferences?.defaultCeilingColor ?? 0xffffff
}

export function getDefaultCeilingVisibility(home: NormalizedHomeState): boolean {
  return home.preferences?.defaultCeilingVisibility ?? true
}
