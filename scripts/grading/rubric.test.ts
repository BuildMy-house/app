import { describe, expect, it } from 'vitest'

import {
  compositeScore,
  isFlaggedForFix,
  scoreGeometry,
  scoreMaterialCompleteness,
  scoreUvTextureMetadata,
  type MapsPresent,
} from './rubric'

const noMaps: MapsPresent = { normal: false, metalness: false, roughness: false, ao: false }
const allMaps: MapsPresent = { normal: true, metalness: true, roughness: true, ao: true }

describe('scoreGeometry', () => {
  it('gives full credit at the general-furniture floor', () => {
    expect(scoreGeometry(500, 'sofa')).toBe(100)
    expect(scoreGeometry(1000, 'dining-table')).toBe(100)
  })

  it('gives the reduced 150 floor to small fixture categories', () => {
    expect(scoreGeometry(150, 'ceiling vent')).toBe(100)
    expect(scoreGeometry(150, 'door handle')).toBe(100)
    expect(scoreGeometry(150, 'kitchen faucet')).toBe(100)
  })

  it('scores 0 at the observed worst-case of 12 polys', () => {
    expect(scoreGeometry(12, 'sofa')).toBe(0)
    expect(scoreGeometry(12, 'vent')).toBe(0)
  })

  it('tapers linearly between worst-case and the category floor', () => {
    expect(scoreGeometry(256, 'sofa')).toBeCloseTo(((256 - 12) / (500 - 12)) * 100)
    expect(scoreGeometry(81, 'vent')).toBeCloseTo(((81 - 12) / (150 - 12)) * 100)
  })

  it('clamps below-worst-case input to 0', () => {
    expect(scoreGeometry(0, 'sofa')).toBe(0)
    expect(scoreGeometry(5, 'lamp')).toBe(0)
  })

  it('is deterministic', () => {
    expect(scoreGeometry(300, 'wardrobe')).toBe(scoreGeometry(300, 'wardrobe'))
  })
})

describe('scoreMaterialCompleteness', () => {
  it('returns 0 whenever the generic fallback material was used, regardless of maps', () => {
    expect(scoreMaterialCompleteness(true, allMaps)).toBe(0)
    expect(scoreMaterialCompleteness(true, noMaps)).toBe(0)
  })

  it('scores 25 points per present map without the fallback', () => {
    expect(scoreMaterialCompleteness(false, noMaps)).toBe(0)
    expect(scoreMaterialCompleteness(false, { ...noMaps, normal: true })).toBe(25)
    expect(scoreMaterialCompleteness(false, { ...noMaps, normal: true, roughness: true })).toBe(50)
    expect(scoreMaterialCompleteness(false, { ...noMaps, normal: true, metalness: true, roughness: true })).toBe(75)
    expect(scoreMaterialCompleteness(false, allMaps)).toBe(100)
  })
})

describe('scoreUvTextureMetadata', () => {
  it('returns 0 when there is no base color texture', () => {
    expect(scoreUvTextureMetadata(false, true, 2048)).toBe(0)
    expect(scoreUvTextureMetadata(false, false, null)).toBe(0)
  })

  it('gives base 50 for a texture with no PBR maps and no resolution metadata', () => {
    expect(scoreUvTextureMetadata(true, false, null)).toBe(50)
  })

  it('gives full credit for PBR maps plus a >= 512px texture', () => {
    expect(scoreUvTextureMetadata(true, true, 512)).toBe(100)
    expect(scoreUvTextureMetadata(true, true, 2048)).toBe(100)
  })

  it('gives 75 for PBR maps with missing resolution metadata', () => {
    expect(scoreUvTextureMetadata(true, true, null)).toBe(75)
  })

  it('tapers the resolution bonus linearly below 512px', () => {
    expect(scoreUvTextureMetadata(true, false, 256)).toBeCloseTo(50 + (256 / 512) * 25)
    expect(scoreUvTextureMetadata(true, true, 100)).toBeCloseTo(75 + (100 / 512) * 25)
    expect(scoreUvTextureMetadata(true, false, 0)).toBe(50)
  })
})

describe('compositeScore', () => {
  it('applies the 20/25/25/30 weights', () => {
    expect(compositeScore({ geometry: 100, uvTexture: 100, material: 100, renderFidelity: 100 })).toBe(100)
    expect(compositeScore({ geometry: 50, uvTexture: 40, material: 60, renderFidelity: 80 })).toBe(59)
    expect(compositeScore({ geometry: 0, uvTexture: 0, material: 0, renderFidelity: 0 })).toBe(0)
  })

  it('clamps to [0, 100]', () => {
    expect(compositeScore({ geometry: 120, uvTexture: 100, material: 100, renderFidelity: 100 })).toBe(100)
    expect(compositeScore({ geometry: -10, uvTexture: 0, material: 0, renderFidelity: 0 })).toBe(0)
  })
})

describe('isFlaggedForFix', () => {
  it('flags when composite < 50', () => {
    expect(isFlaggedForFix(49.9, 100)).toBe(true)
  })

  it('flags when renderFidelity < 30', () => {
    expect(isFlaggedForFix(90, 29.9)).toBe(true)
  })

  it('flags when both branches trigger', () => {
    expect(isFlaggedForFix(10, 10)).toBe(true)
  })

  it('does not flag when neither branch triggers (boundaries exclusive)', () => {
    expect(isFlaggedForFix(50, 30)).toBe(false)
    expect(isFlaggedForFix(100, 100)).toBe(false)
  })
})
