/**
 * viewport-quality.ts — Runtime 3D viewport quality settings (SH3D "3D
 * rendering quality" parity, ticket U8).
 *
 * A small, persisted settings object that the View3D applies live:
 *   - pixelRatio cap (sharpness)
 *   - shadow map resolution (soft vs. crisp shadows)
 *   - antialias
 *   - distance fog (subtle depth cueing)
 *   - texture anisotropy
 *
 * Presets are the SH3D-like scale: low / medium / high / ultra. The value is
 * a plain JSON-serializable object so it can be persisted and (later) driven
 * over the automation/MCP surface.
 */

export type ViewportQualityPreset = 'low' | 'medium' | 'high' | 'ultra'

export interface ViewportQuality {
  preset: ViewportQualityPreset
  /** Cap on devicePixelRatio used for the renderer (1 = crisp on 1x, 2 = retina). */
  pixelRatioCap: number
  /** Shadow map size in texels per axis (power of two). */
  shadowMapSize: number
  antialias: boolean
  /** Distance fog density (0 disables fog). */
  fogDensity: number
  /** Max texture anisotropy. */
  maxAnisotropy: number
}

export const VIEWPORT_PRESETS: Record<ViewportQualityPreset, ViewportQuality> = {
  low: {
    preset: 'low',
    pixelRatioCap: 1,
    shadowMapSize: 1024,
    antialias: false,
    fogDensity: 0,
    maxAnisotropy: 1,
  },
  medium: {
    preset: 'medium',
    pixelRatioCap: 1.5,
    shadowMapSize: 2048,
    antialias: true,
    fogDensity: 0.00005,
    maxAnisotropy: 4,
  },
  high: {
    preset: 'high',
    pixelRatioCap: 2,
    shadowMapSize: 4096,
    antialias: true,
    fogDensity: 0.00005,
    maxAnisotropy: 8,
  },
  ultra: {
    preset: 'ultra',
    pixelRatioCap: 3,
    shadowMapSize: 8192,
    antialias: true,
    fogDensity: 0.00004,
    maxAnisotropy: 16,
  },
}

export const DEFAULT_VIEWPORT_QUALITY: ViewportQuality = VIEWPORT_PRESETS.medium

const STORAGE_KEY = 'homely-viewport-quality'

export function loadViewportQuality(storage: Pick<Storage, 'getItem'> = localStorage): ViewportQuality {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_VIEWPORT_QUALITY }
    const parsed = JSON.parse(raw) as Partial<ViewportQuality>
    const base = VIEWPORT_PRESETS[parsed.preset ?? 'medium'] ?? DEFAULT_VIEWPORT_QUALITY
    // Sanity-clamp any numeric overrides; never trust stored values blindly.
    return {
      preset: base.preset,
      pixelRatioCap: clampNum(parsed.pixelRatioCap, 1, 4, base.pixelRatioCap),
      shadowMapSize: clampNum(parsed.shadowMapSize, 256, 8192, base.shadowMapSize),
      antialias: typeof parsed.antialias === 'boolean' ? parsed.antialias : base.antialias,
      fogDensity: clampNum(parsed.fogDensity, 0, 0.001, base.fogDensity),
      maxAnisotropy: clampNum(parsed.maxAnisotropy, 1, 16, base.maxAnisotropy),
    }
  } catch {
    return { ...DEFAULT_VIEWPORT_QUALITY }
  }
}

export function saveViewportQuality(
  quality: ViewportQuality,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(quality))
  } catch {
    // Storage unavailable (private mode / headless): keep in-memory only.
  }
}

function clampNum(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}
