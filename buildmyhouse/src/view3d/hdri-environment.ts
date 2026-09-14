/**
 * hdri-environment.ts — HDRI environment lighting + background (MAT-T4).
 *
 * Loads equirectangular .hdr files (CC0, Poly Haven — see
 * public/assets/hdri/LICENSE.md), pre-filters them through PMREMGenerator,
 * and applies the result to both scene.environment (IBL lighting + strong
 * reflections on materials) and scene.background (real sky).
 *
 * The chosen preset is a viewport preference (localStorage), not part of the
 * home document — mirrors viewport-quality.ts. View3D owns an instance and
 * re-applies after every scene rebuild (rebuild() creates a fresh Scene).
 */
import * as THREE from 'three'
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js'

export type HdriPresetId = 'studio' | 'daylight' | 'overcast'

export interface HdriPreset {
  id: HdriPresetId
  label: string
  url: string
}

export const HDRI_PRESETS: Record<HdriPresetId, HdriPreset> = {
  studio: {
    id: 'studio',
    label: 'Studio',
    url: 'assets/hdri/photo_studio_01_1k.hdr',
  },
  daylight: {
    id: 'daylight',
    label: 'Daylight',
    url: 'assets/hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr',
  },
  overcast: {
    id: 'overcast',
    label: 'Overcast',
    url: 'assets/hdri/overcast_soil_puresky_1k.hdr',
  },
}

const DEFAULT_HDRI_PRESET: HdriPresetId = 'studio'

const HDRI_STORAGE_KEY = 'homely-hdri-preset'

// Storage is resolved inside the try (not as a default param) so headless
// envs without `localStorage` hit the catch instead of a ReferenceError.
export function loadHdriPresetId(storage?: Pick<Storage, 'getItem'>): HdriPresetId {
  try {
    const raw = (storage ?? localStorage).getItem(HDRI_STORAGE_KEY)
    if (raw && raw in HDRI_PRESETS) return raw as HdriPresetId
  } catch {
    // Storage unavailable (private mode / headless): fall through to default.
  }
  return DEFAULT_HDRI_PRESET
}

export function saveHdriPresetId(id: HdriPresetId, storage?: Pick<Storage, 'setItem'>): void {
  try {
    ;(storage ?? localStorage).setItem(HDRI_STORAGE_KEY, id)
  } catch {
    // Storage unavailable: keep in-memory only.
  }
}

// With a real environment map providing IBL, the flat analytic lights from
// buildScene would double-light the scene into a washed-out look. Dim them to
// fixed values (never multiply — rebuild() creates fresh lights each time).
const ENV_ACTIVE_HEMI_INTENSITY = 0.35
const ENV_ACTIVE_AMBIENT_INTENSITY = 0.15

/**
 * Per-renderer HDRI manager: loads + PMREM-filters each preset once, caches
 * the resulting texture, and guards against stale async applies when the
 * preset is switched while a load is in flight.
 */
export class HdriEnvironment {
  private readonly loader = new RGBELoader()
  private pmrem: THREE.PMREMGenerator
  private readonly cache = new Map<HdriPresetId, THREE.Texture>()
  private desired: HdriPresetId | undefined
  private failed = new Set<HdriPresetId>()

  constructor(renderer: THREE.WebGLRenderer) {
    this.pmrem = new THREE.PMREMGenerator(renderer)
  }

  /**
   * Apply preset `id` to `scene` (environment + background). Synchronous when
   * the preset is already cached; resolves after apply otherwise. Rejects if
   * the .hdr fails to load (caller decides the fallback).
   */
  async applyTo(scene: THREE.Scene, id: HdriPresetId): Promise<void> {
    this.desired = id
    let texture = this.cache.get(id)
    if (!texture) {
      if (this.failed.has(id)) throw new Error(`HDRI '${id}' previously failed to load`)
      const preset = HDRI_PRESETS[id]
      const hdr = await this.loader.loadAsync(preset.url)
      // Another applyTo (different preset) started while we awaited: drop
      // this stale result instead of clobbering the newer selection.
      if (this.desired !== id) {
        hdr.dispose()
        return
      }
      texture = this.pmrem.fromEquirectangular(hdr).texture
      hdr.dispose()
      this.cache.set(id, texture)
    }
    scene.environment = texture
    scene.background = texture
    scene.backgroundBlurriness = 0
    this.dimFlatLights(scene)
  }

  /** Forget a preset that failed so a later retry can try again. */
  resetFailure(id: HdriPresetId): void {
    this.failed.delete(id)
  }

  dispose(): void {
    this.desired = undefined
    for (const texture of this.cache.values()) texture.dispose()
    this.cache.clear()
    this.pmrem.dispose()
  }

  private dimFlatLights(scene: THREE.Scene): void {
    scene.traverse((object) => {
      if ((object as THREE.HemisphereLight).isHemisphereLight) {
        ;(object as THREE.HemisphereLight).intensity = ENV_ACTIVE_HEMI_INTENSITY
      } else if ((object as THREE.AmbientLight).isAmbientLight) {
        ;(object as THREE.AmbientLight).intensity = ENV_ACTIVE_AMBIENT_INTENSITY
      }
    })
  }
}
