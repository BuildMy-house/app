/**
 * Deterministic, pure scoring rubric for the asset quality scorecard pipeline.
 * Every function is side-effect free and returns a value clamped to [0, 100].
 *
 * Geometry floors (Part D of the proposal): small fixtures/vents are legitimately
 * low-poly, so they get a lower "full credit" floor than general furniture.
 * Categories whose name contains a small-fixture keyword (vent, fan, handle,
 * fixture, knob, hinge, faucet, switch, outlet, radiator, hook, bracket, lamp)
 * get a 150-poly floor; everything else (sofas, tables, beds, cabinets, ...)
 * gets 500. Both taper linearly down to 0 at 12 polys — the observed worst-case
 * (a flat untextured plane) in the catalog.
 */

export interface MapsPresent {
  normal: boolean
  metalness: boolean
  roughness: boolean
  ao: boolean
}

export interface ComponentScores {
  geometry: number
  uvTexture: number
  material: number
  renderFidelity: number
}

const WORST_CASE_POLYS = 12
const GENERAL_POLY_FLOOR = 500
const SMALL_FIXTURE_POLY_FLOOR = 150

const SMALL_FIXTURE_KEYWORDS = [
  'vent',
  'fan',
  'handle',
  'fixture',
  'knob',
  'hinge',
  'faucet',
  'switch',
  'outlet',
  'radiator',
  'hook',
  'bracket',
  'lamp',
]

function polyFloorForCategory(category: string): number {
  const c = category.toLowerCase()
  return SMALL_FIXTURE_KEYWORDS.some((k) => c.includes(k))
    ? SMALL_FIXTURE_POLY_FLOOR
    : GENERAL_POLY_FLOOR
}

function clamp0to100(value: number): number {
  return Math.min(100, Math.max(0, value))
}

export function scoreGeometry(polyCount: number, category: string): number {
  const floor = polyFloorForCategory(category)
  if (polyCount >= floor) return 100
  const span = floor - WORST_CASE_POLYS
  return clamp0to100(((polyCount - WORST_CASE_POLYS) / span) * 100)
}

export function scoreMaterialCompleteness(
  usedFallbackMaterial: boolean,
  mapsPresent: MapsPresent,
): number {
  if (usedFallbackMaterial) return 0
  const present = [mapsPresent.normal, mapsPresent.metalness, mapsPresent.roughness, mapsPresent.ao]
  return present.filter(Boolean).length * 25
}

export function scoreUvTextureMetadata(
  hasBaseColorTexture: boolean,
  hasPbrMaps: boolean,
  textureMaxPx: number | null,
): number {
  if (!hasBaseColorTexture) return 0
  let score = 50
  if (hasPbrMaps) score += 25
  if (textureMaxPx != null) {
    score += textureMaxPx >= 512 ? 25 : (textureMaxPx / 512) * 25
  }
  return clamp0to100(score)
}

export function compositeScore(scores: ComponentScores): number {
  const raw =
    scores.geometry * 0.2 + scores.uvTexture * 0.25 + scores.material * 0.25 + scores.renderFidelity * 0.3
  return clamp0to100(raw)
}

export function isFlaggedForFix(composite: number, renderFidelity: number): boolean {
  return composite < 50 || renderFidelity < 30
}
