import type { Point } from './geometry'

export type UnitSystem = 'cm' | 'inch'

export interface LengthSnapConfig {
  stepCm: number
  majorCm: number
  fineStepCm: number
}

// 4 in / 1 ft / 1 in expressed in centimetres.
const LENGTH_SNAP_CONFIG: Record<UnitSystem, LengthSnapConfig> = {
  cm: { stepCm: 10, majorCm: 100, fineStepCm: 1 },
  inch: { stepCm: 10.16, majorCm: 30.48, fineStepCm: 2.54 },
}

export function lengthSnapConfig(unit: UnitSystem): LengthSnapConfig {
  return LENGTH_SNAP_CONFIG[unit]
}

export type LengthLock = 'step' | 'major' | 'fine'

export interface SnapLengthOptions {
  fine?: boolean
  wasAtMajor?: boolean
}

export interface LengthSnapResult {
  lengthCm: number
  lock: LengthLock
}

/**
 * Snap a raw length onto the unit's step grid. A plain step rounding is
 * overridden by a "major" (whole metre / foot) when the raw length lands
 * within 0.8 * step of it; a length already on a major is held until it
 * leaves 1.2 * step of it (hysteresis). `fine` switches to the 1 cm / 1 in
 * grid and disables major stickiness entirely. Never returns a negative
 * length.
 */
export function snapLength(
  rawCm: number,
  cfg: LengthSnapConfig,
  opts: SnapLengthOptions = {},
): LengthSnapResult {
  if (opts.fine) {
    const value = Math.max(0, Math.round(rawCm / cfg.fineStepCm) * cfg.fineStepCm)
    return { lengthCm: value, lock: 'fine' }
  }

  const majorCapture = 0.8 * cfg.stepCm
  const majorRelease = 1.2 * cfg.stepCm
  const nearestMajor = Math.round(rawCm / cfg.majorCm) * cfg.majorCm
  const majorDeviation = Math.abs(rawCm - nearestMajor)

  if (majorDeviation <= majorCapture || (opts.wasAtMajor === true && majorDeviation <= majorRelease)) {
    return { lengthCm: Math.max(0, nearestMajor), lock: 'major' }
  }

  const value = Math.max(0, Math.round(rawCm / cfg.stepCm) * cfg.stepCm)
  return { lengthCm: value, lock: 'step' }
}

export type AngleLock = 'none' | 'step' | 'diagonal' | 'axis'
export type AngleMode = 'soft' | 'hard'

export interface SnapAngleOptions {
  baseDegs?: number[]
  wasLockedDeg?: number | null
}

export interface AngleSnapResult {
  angleDeg: number
  lock: AngleLock
}

const STEP_DEG = 15
const SOFT_CAPTURE: Record<'axis' | 'diagonal' | 'step', number> = { axis: 8, diagonal: 6, step: 3 }
const HARD_STICKY_CAPTURE = 10
const HYSTERESIS_BONUS = 2
// Stronger locks win ties: an axis lock beats a diagonal beats a plain step.
const LOCK_RANK: Record<'axis' | 'diagonal' | 'step', number> = { axis: 0, diagonal: 1, step: 2 }

/** Normalise any angle into (-180, 180]. */
function normalizeDeg(deg: number): number {
  let d = deg % 360
  if (d > 180) d -= 360
  if (d <= -180) d += 360
  return d
}

/** Kill float residue for values that are meant to be exact integers. */
function snapExact(value: number): number {
  const rounded = Math.round(value)
  return Math.abs(value - rounded) < 1e-9 ? rounded : value
}

/** Classify a relative direction that is already a multiple of 15°. */
function classifyRelative(relDeg: number): 'axis' | 'diagonal' | 'step' {
  const n = Math.round(relDeg / STEP_DEG)
  if (n % 6 === 0) return 'axis'
  if (n % 3 === 0) return 'diagonal'
  return 'step'
}

interface AngleCandidate {
  angleDeg: number
  deviationDeg: number
  lock: 'axis' | 'diagonal' | 'step'
  baseIndex: number
}

function angleCandidates(baseDeg: number, rawDeg: number, baseIndex: number): AngleCandidate[] {
  const rel = normalizeDeg(rawDeg - baseDeg)
  const floorRel = Math.floor(rel / STEP_DEG) * STEP_DEG
  const out: AngleCandidate[] = []
  for (const cRel of [floorRel, floorRel + STEP_DEG]) {
    out.push({
      angleDeg: snapExact(normalizeDeg(baseDeg + cRel)),
      deviationDeg: Math.abs(rel - cRel),
      lock: classifyRelative(cRel),
      baseIndex,
    })
  }
  return out
}

function isBetter(candidate: AngleCandidate, current: AngleCandidate): boolean {
  if (candidate.deviationDeg !== current.deviationDeg) {
    return candidate.deviationDeg < current.deviationDeg
  }
  const candidateRank = LOCK_RANK[candidate.lock]
  const currentRank = LOCK_RANK[current.lock]
  if (candidateRank !== currentRank) return candidateRank < currentRank
  return candidate.baseIndex < current.baseIndex
}

/**
 * Snap a direction onto the 15° grid, relative to each base direction in
 * `baseDegs` (default world axes `[0]`; the engine also passes the previous
 * wall's direction so walls can snap parallel/perpendicular/stepwise to it).
 * A relative multiple of 90° is an 'axis' lock, an odd multiple of 45° is a
 * 'diagonal', any other multiple of 15° is a 'step'.
 *
 * Soft mode only locks within the per-type capture radii (3/6/8°), extended
 * by 2° for the candidate that matches `wasLockedDeg` (hysteresis); an
 * uncaptured result falls back to the raw angle with a 'none' lock.
 *
 * Hard mode (Shift) always locks: axis/diagonal targets capture within 10°
 * first (stickier than a plain 15° step), then it falls back to the nearest
 * 15° multiple.
 */
export function snapAngle(
  rawDeg: number,
  mode: AngleMode,
  opts: SnapAngleOptions = {},
): AngleSnapResult {
  const bases = opts.baseDegs && opts.baseDegs.length > 0 ? opts.baseDegs : [0]
  const wasLocked = opts.wasLockedDeg ?? null

  const captured: AngleCandidate[] = []
  bases.forEach((base, baseIndex) => {
    for (const candidate of angleCandidates(base, rawDeg, baseIndex)) {
      if (mode === 'hard') {
        if (candidate.lock !== 'step' && candidate.deviationDeg <= HARD_STICKY_CAPTURE) {
          captured.push(candidate)
        }
        continue
      }
      let capture = SOFT_CAPTURE[candidate.lock]
      if (wasLocked !== null && Math.abs(normalizeDeg(candidate.angleDeg - wasLocked)) < 1e-9) {
        capture += HYSTERESIS_BONUS
      }
      if (candidate.deviationDeg <= capture) captured.push(candidate)
    }
  })

  if (captured.length > 0) {
    const best = captured.reduce((a, b) => (isBetter(b, a) ? b : a))
    return { angleDeg: best.angleDeg, lock: best.lock }
  }

  if (mode === 'hard') {
    // Hard mode always locks: fall back to the nearest 15° multiple.
    const fallbacks = bases.map((base, baseIndex) => {
      const rel = normalizeDeg(rawDeg - base)
      const cRel = Math.round(rel / STEP_DEG) * STEP_DEG
      return {
        angleDeg: snapExact(normalizeDeg(base + cRel)),
        deviationDeg: Math.abs(rel - cRel),
        lock: classifyRelative(cRel),
        baseIndex,
      }
    })
    const best = fallbacks.reduce((a, b) => (isBetter(b, a) ? b : a))
    return { angleDeg: best.angleDeg, lock: best.lock }
  }

  return { angleDeg: snapExact(normalizeDeg(rawDeg)), lock: 'none' }
}

export type SnapMode = 'soft' | 'hard' | 'off'

/**
 * Resolve the effective snap mode from the modifier keys. Alt (Option) always
 * wins and disables snapping; Shift explicitly requests hard snapping even
 * when auto-snap is disabled.
 */
export function resolveSnapMode(mods: { shift: boolean; alt: boolean }, enabled: boolean): SnapMode {
  if (mods.alt) return 'off'
  if (mods.shift) return 'hard'
  return enabled ? 'soft' : 'off'
}

export type SegmentLengthLock = 'none' | LengthLock

export interface SnapWallSegmentInput {
  start: Point
  cursor: Point
  unit: UnitSystem
  mode: SnapMode
  fine?: boolean
  prevDirDeg?: number | null
  typedLengthCm?: number | null
  prev?: { lengthMajor: boolean; angleLockedDeg: number | null } | null
}

export interface SnapWallSegmentResult {
  end: Point
  lengthCm: number
  angleDeg: number
  lengthLock: SegmentLengthLock
  angleLock: AngleLock
  state: { lengthMajor: boolean; angleLockedDeg: number | null }
}

/** cos/sin that is exact on the world axes (no residue at 0/±90/180°). */
function directionCosSin(angleDeg: number): { cos: number; sin: number } {
  const quarters = angleDeg / 90
  const rounded = Math.round(quarters)
  if (Math.abs(quarters - rounded) < 1e-9) {
    const q = ((rounded % 4) + 4) % 4
    if (q === 0) return { cos: 1, sin: 0 }
    if (q === 1) return { cos: 0, sin: 1 }
    if (q === 2) return { cos: -1, sin: 0 }
    return { cos: 0, sin: -1 }
  }
  const rad = (angleDeg * Math.PI) / 180
  return { cos: Math.cos(rad), sin: Math.sin(rad) }
}

function positiveLength(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Full wall-drawing snap: angle via {@link snapAngle} (world axes plus the
 * previous wall's direction when given), length via {@link snapLength}, or an
 * exact typed length. Axis-locked ends are produced with exact integer
 * offsets. `off` mode returns the raw cursor unless a typed length is given.
 */
export function snapWallSegment(input: SnapWallSegmentInput): SnapWallSegmentResult {
  const { start, cursor, unit, mode } = input
  const dx = cursor.x - start.x
  const dy = cursor.y - start.y

  if (dx === 0 && dy === 0) {
    return {
      end: { x: start.x, y: start.y },
      lengthCm: 0,
      angleDeg: 0,
      lengthLock: 'none',
      angleLock: 'none',
      state: { lengthMajor: false, angleLockedDeg: null },
    }
  }

  const rawLength = Math.hypot(dx, dy)
  const rawAngle = (Math.atan2(dy, dx) * 180) / Math.PI
  const typed = positiveLength(input.typedLengthCm)

  if (mode === 'off') {
    // No typed length: hand back the raw cursor verbatim (no float recompute).
    if (typed === null) {
      return {
        end: { x: cursor.x, y: cursor.y },
        lengthCm: rawLength,
        angleDeg: snapExact(normalizeDeg(rawAngle)),
        lengthLock: 'none',
        angleLock: 'none',
        state: { lengthMajor: false, angleLockedDeg: null },
      }
    }
    const { cos, sin } = directionCosSin(rawAngle)
    return {
      end: { x: start.x + typed * cos, y: start.y + typed * sin },
      lengthCm: typed,
      angleDeg: snapExact(normalizeDeg(rawAngle)),
      lengthLock: 'none',
      angleLock: 'none',
      state: { lengthMajor: false, angleLockedDeg: null },
    }
  }

  const baseDegs = input.prevDirDeg == null ? [0] : [0, input.prevDirDeg]
  const angle = snapAngle(rawAngle, mode, {
    baseDegs,
    wasLockedDeg: input.prev?.angleLockedDeg ?? null,
  })

  let lengthCm: number
  let lengthLock: SegmentLengthLock
  if (typed !== null) {
    lengthCm = typed
    lengthLock = 'none'
  } else {
    const snapped = snapLength(rawLength, lengthSnapConfig(unit), {
      fine: input.fine,
      wasAtMajor: input.prev?.lengthMajor ?? false,
    })
    lengthCm = snapped.lengthCm
    lengthLock = snapped.lock
  }

  const { cos, sin } = directionCosSin(angle.angleDeg)
  return {
    end: { x: start.x + lengthCm * cos, y: start.y + lengthCm * sin },
    lengthCm,
    angleDeg: angle.angleDeg,
    lengthLock,
    angleLock: angle.lock,
    state: {
      lengthMajor: lengthLock === 'major',
      angleLockedDeg: angle.lock === 'none' ? null : angle.angleDeg,
    },
  }
}
