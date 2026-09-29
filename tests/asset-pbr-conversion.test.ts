import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { convertPhongToStandard } from '../src/services/asset-ingestion-service'

describe('convertPhongToStandard', () => {
  it('reads metallic input as metalness≈1 with low roughness', () => {
    // Gold-like MTL: Kd tinted like Ks, high Ns.
    const phong = new THREE.MeshPhongMaterial({
      color: new THREE.Color(0.8, 0.6, 0.3),
      specular: new THREE.Color(1, 0.77, 0.34),
      shininess: 900,
    })
    const standard = convertPhongToStandard(phong)
    expect(standard).toBeInstanceOf(THREE.MeshStandardMaterial)
    expect(standard.metalness).toBeGreaterThan(0.8)
    expect(standard.roughness).toBeLessThan(0.15)
  })

  it('reads dielectric/matte input as metalness≈0 with higher roughness', () => {
    // White fabric MTL: neutral white/grey specular, low Ns.
    const phong = new THREE.MeshPhongMaterial({
      color: new THREE.Color(0.9, 0.9, 0.9),
      specular: new THREE.Color(0.3, 0.3, 0.3),
      shininess: 10,
    })
    const standard = convertPhongToStandard(phong)
    expect(standard.metalness).toBe(0)
    expect(standard.roughness).toBeCloseTo(0.99, 5)
  })

  it('clamps roughness at the 0.05 floor for mirror-smooth shininess', () => {
    const phong = new THREE.MeshPhongMaterial({ shininess: 5000 })
    const standard = convertPhongToStandard(phong)
    expect(standard.roughness).toBe(0.05)
  })

  it('treats near-black specular as dielectric regardless of diffuse', () => {
    // MTLLoader's default specular 0x111111: no metal signal.
    const phong = new THREE.MeshPhongMaterial({
      color: new THREE.Color(0.8, 0.6, 0.3),
      shininess: 1000,
    })
    const standard = convertPhongToStandard(phong)
    expect(standard.metalness).toBe(0)
  })

  it('carries over shared material properties', () => {
    const map = new THREE.Texture()
    const phong = new THREE.MeshPhongMaterial({
      name: 'brass_handle',
      color: new THREE.Color(0.8, 0.6, 0.3),
      map,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
    })
    const standard = convertPhongToStandard(phong)
    expect(standard.name).toBe('brass_handle')
    expect(standard.color.equals(phong.color)).toBe(true)
    expect(standard.map).toBe(map)
    expect(standard.transparent).toBe(true)
    expect(standard.opacity).toBe(0.7)
    expect(standard.side).toBe(THREE.DoubleSide)
  })

  it('classifies transparent glass with weak Ns as glossy', () => {
    // Window glass MTL: d 0.5 (MTLLoader -> opacity 0.5), author left Ns low.
    const phong = new THREE.MeshPhongMaterial({ transparent: true, opacity: 0.5, shininess: 10 })
    const standard = convertPhongToStandard(phong)
    expect(standard.roughness).toBeLessThanOrEqual(0.3)
  })

  it('clamps roughness into the glossy band when raw MTL illum marks glass', () => {
    // illum 4 = "transparency: glass on" per the MTL spec; MTLLoader does not
    // surface illum, so it arrives via the raw materialsInfo entry.
    const phong = new THREE.MeshPhongMaterial({ shininess: 10 })
    const info = { illum: '4', d: '1' } as unknown as Parameters<typeof convertPhongToStandard>[1]
    const standard = convertPhongToStandard(phong, info)
    expect(standard.roughness).toBeLessThanOrEqual(0.3)
  })

  it('keeps the Ns-derived roughness when opacity is only near-opaque and illum is absent', () => {
    const phong = new THREE.MeshPhongMaterial({ shininess: 10, opacity: 0.97 })
    const standard = convertPhongToStandard(phong)
    expect(standard.roughness).toBeCloseTo(0.99, 5)
  })

  it('keeps the Ns-derived roughness for illum 0-2 (no reflection/transparency model)', () => {
    const phong = new THREE.MeshPhongMaterial({ shininess: 10 })
    const info = { illum: '2' } as unknown as Parameters<typeof convertPhongToStandard>[1]
    const standard = convertPhongToStandard(phong, info)
    expect(standard.roughness).toBeCloseTo(0.99, 5)
  })

  it('recovers zero-signal exact-named glass: glossy band + forced transparency', () => {
    // DianaWindow/Glass MTL: Kd 0 0 0, Ks 0 0 0, illum 1, no d — renders
    // solid opaque black without the name-based fallback.
    const phong = new THREE.MeshPhongMaterial({ name: 'Glass', shininess: 10 })
    const standard = convertPhongToStandard(phong)
    expect(standard.roughness).toBeLessThanOrEqual(0.3)
    expect(standard.transparent).toBe(true)
    expect(standard.opacity).toBe(0.5)
  })

  it('recovers cabinet glass (illum 2, Ns 129, no d) the same way', () => {
    // 1/2GlassDoorCabinet "glass" MTL: Kd 0.1328 0.15272 0.166, Ns 129, illum 2.
    const phong = new THREE.MeshPhongMaterial({
      name: 'glass',
      color: new THREE.Color(0.1328, 0.15272, 0.166),
      shininess: 129,
    })
    const standard = convertPhongToStandard(phong)
    expect(standard.roughness).toBeLessThanOrEqual(0.3)
    expect(standard.transparent).toBe(true)
    expect(standard.opacity).toBe(0.5)
  })

  it('respects explicit d even when it is fully opaque', () => {
    // window_stain_glass/Glass sets d 1.0 — author intent, never overridden.
    const phong = new THREE.MeshPhongMaterial({ name: 'Glass', shininess: 10 })
    const info = { d: '1' } as unknown as Parameters<typeof convertPhongToStandard>[1]
    const standard = convertPhongToStandard(phong, info)
    expect(standard.transparent).toBe(false)
    expect(standard.opacity).toBe(1)
    expect(standard.roughness).toBeLessThanOrEqual(0.3)
  })

  it('clamps mirror roughness but never forces transparency on mirrors', () => {
    // ceiling_lamp_globo_feria/Mirror: Ns 96, no d — mirrors are opaque.
    const phong = new THREE.MeshPhongMaterial({ name: 'Mirror', shininess: 96 })
    const standard = convertPhongToStandard(phong)
    expect(standard.roughness).toBeLessThanOrEqual(0.3)
    expect(standard.transparent).toBe(false)
  })

  it('ignores glass-like names that are not exactly glass/mirror', () => {
    // doorGlassPanels "Door_GlassPanels_1" is a textured door lock, not glass.
    const phong = new THREE.MeshPhongMaterial({ name: 'Door_GlassPanels_1', shininess: 10 })
    const standard = convertPhongToStandard(phong)
    expect(standard.roughness).toBeCloseTo(0.99, 5)
    expect(standard.transparent).toBe(false)
  })
})
