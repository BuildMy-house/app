import type { NormalizedHomeState } from './home'
import type { CompassState, EnvironmentState } from './home'

/**
 * Deterministic wire-format export (docs/specs/ws-protocol.md determinism
 * rules + docs/behaviours/sh3d-camera-and-export.md §2): centimeter lengths
 * and degree angles are rounded half-even to 3 decimals; yaw/pitch degrees
 * wrap into [-180, 180) so yaw π exports as -180.0 (driver toDeg() parity);
 * fovDeg is a coordinate-like value — plain round3, never wrapped; arcExtent
 * stays untouched; compass latitudeRad/longitudeRad export round3.
 */

export function roundHalfEven(value: number, decimals = 3): number {
  if (!Number.isFinite(value)) return value
  const factor = 10 ** decimals
  const scaled = value * factor
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  let rounded: number
  // Binary-float products can land epsilon-below/above an exact decimal tie
  // (e.g. 8.1855 * 1000 === 8185.499999...). Treat near-ties as ties so the
  // result matches exact decimal half-even rounding (BigDecimal(String)).
  if (Math.abs(diff - 0.5) < TIE_EPSILON) {
    rounded = floor % 2 === 0 ? floor : floor + 1
  } else {
    rounded = diff > 0.5 ? floor + 1 : floor
  }
  return rounded / factor
}

const TIE_EPSILON = 1e-9

/**
 * Normalize degrees the way the driver's toDeg() lands after round3:
 * into [-180, 180). 180 (yaw π) wraps to -180 — golden parity, NOT (+)180.
 */
export function normalizeAngle(deg: number): number {
  if (!Number.isFinite(deg)) return deg
  let n = ((deg % 360) + 360) % 360
  if (n >= 180) n -= 360
  return n
}

const roundLen = (v: number): number => roundHalfEven(v)
const roundAngle = (v: number | undefined): number | undefined =>
  v === undefined ? undefined : roundHalfEven(normalizeAngle(v))
// fovDeg exports like a coordinate: plain round3, never angle-wrapped
// (spherical-lens fov may legitimately exceed 180).
const roundFov = (v: number): number => roundHalfEven(v)

function roundPoint([x, y]: [number, number]): [number, number] {
  return [roundLen(x), roundLen(y)]
}

/**
 * Produce the canonical export object. Input is never mutated. The output is
 * plain JSON-safe data with identical shape to NormalizedHomeState.
 */
export function serializeHome(home: NormalizedHomeState): NormalizedHomeState {
  return {
    ...home,
    levels: home.levels.map((level) => ({
      ...level,
      elevation: roundLen(level.elevation),
      floorThickness: roundLen(level.floorThickness),
      height: roundLen(level.height),
    })),
    walls: home.walls.map((wall) => ({
      ...wall,
      xStart: roundLen(wall.xStart),
      yStart: roundLen(wall.yStart),
      xEnd: roundLen(wall.xEnd),
      yEnd: roundLen(wall.yEnd),
      thickness: roundLen(wall.thickness),
      height: wall.height === null || wall.height === undefined ? wall.height : roundLen(wall.height),
      heightAtEnd:
        wall.heightAtEnd === null || wall.heightAtEnd === undefined
          ? wall.heightAtEnd
          : roundLen(wall.heightAtEnd),
      // arcExtent stays raw radians by contract
    })),
    rooms: home.rooms.map((room) => ({
      ...room,
      points: room.points.map(roundPoint),
    })),
    furniture: home.furniture.map((f) => ({
      ...f,
      x: roundLen(f.x),
      y: roundLen(f.y),
      elevation: roundLen(f.elevation),
      width: roundLen(f.width),
      depth: roundLen(f.depth),
      height: roundLen(f.height),
      angleDeg: roundAngle(f.angleDeg)!,
      pitchDeg: f.pitchDeg === undefined ? undefined : roundAngle(f.pitchDeg),
      rollDeg: f.rollDeg === undefined ? undefined : roundAngle(f.rollDeg),
      modelRotationDeg: f.modelRotationDeg?.map(
        (triple) => triple.map((v) => roundAngle(v)!) as [number, number, number],
      ),
    })),
    dimensionLines: home.dimensionLines.map((d) => ({
      ...d,
      xStart: roundLen(d.xStart),
      yStart: roundLen(d.yStart),
      xEnd: roundLen(d.xEnd),
      yEnd: roundLen(d.yEnd),
      offset: roundLen(d.offset),
      elevationStart: d.elevationStart === undefined ? undefined : roundLen(d.elevationStart),
      elevationEnd: d.elevationEnd === undefined ? undefined : roundLen(d.elevationEnd),
    })),
    labels: home.labels.map((label) => ({
      ...label,
      x: roundLen(label.x),
      y: roundLen(label.y),
      angleDeg: label.angleDeg === undefined ? undefined : roundAngle(label.angleDeg),
      elevation: label.elevation === undefined ? undefined : roundLen(label.elevation),
    })),
    roofs: home.roofs.map((roof) => ({
      ...roof,
      points: roof.points.map(roundPoint),
    })),
    cameras: {
      top: {
        ...home.cameras.top,
        x: roundLen(home.cameras.top.x),
        y: roundLen(home.cameras.top.y),
        z: roundLen(home.cameras.top.z),
        yawDeg: roundAngle(home.cameras.top.yawDeg)!,
        pitchDeg: roundAngle(home.cameras.top.pitchDeg)!,
        fovDeg: roundFov(home.cameras.top.fovDeg),
      },
      observer: {
        ...home.cameras.observer,
        x: roundLen(home.cameras.observer.x),
        y: roundLen(home.cameras.observer.y),
        z: roundLen(home.cameras.observer.z),
        yawDeg: roundAngle(home.cameras.observer.yawDeg)!,
        pitchDeg: roundAngle(home.cameras.observer.pitchDeg)!,
        fovDeg: roundFov(home.cameras.observer.fovDeg),
      },
    },
    compass: serializeCompass(home.compass),
    environment: serializeEnvironment(home.environment),
  }
}

function serializeCompass(compass: CompassState): CompassState {
  return {
    ...compass,
    x: roundLen(compass.x),
    y: roundLen(compass.y),
    diameter: roundLen(compass.diameter),
    northDirectionDeg: roundAngle(compass.northDirectionDeg)!,
    // Driver exports round3 of the stored (float) radians — golden 0.48/1.564.
    latitudeRad: roundHalfEven(compass.latitudeRad),
    longitudeRad: roundHalfEven(compass.longitudeRad),
  }
}

function serializeEnvironment(environment: EnvironmentState): EnvironmentState {
  return {
    ...environment,
    wallsAlpha:
      environment.wallsAlpha === null || environment.wallsAlpha === undefined
        ? environment.wallsAlpha
        : roundHalfEven(environment.wallsAlpha),
  }
}
