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
})
