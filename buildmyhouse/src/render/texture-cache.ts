/**
 * texture-cache.ts — File-based texture cache with UV parameter tracking.
 *
 * Manages texture assets for the rendering pipeline:
 * - Stores textures in a flat files/ directory keyed by content hash
 * - Tracks UV mapping parameters per texture instance
 * - Supports both SH3D-extracted and user-provided textures
 * - Provides texture lookups by ID for material assignment
 */

import type { TextureDef } from './scene-graph'

// ── UV mapping parameters (from SH3D HomeTexture) ──────────────

export interface UvParams {
  scale: number
  offsetU: number
  offsetV: number
  rotation: number
  wrap: 'repeat' | 'clamp'
  fittingArea: 0 | 1 | 2 // 0=fitToArea, 1=stretch, 2=tile
}

const DEFAULT_UV: UvParams = {
  scale: 1,
  offsetU: 0,
  offsetV: 0,
  rotation: 0,
  wrap: 'repeat',
  fittingArea: 0,
}

// ── Texture entry ───────────────────────────────────────────────

export interface TextureEntry {
  def: TextureDef
  /** Content hash (SHA-256 prefix) used as file key */
  hash: string
  /** Absolute path to the cached file on disk */
  filePath: string
  /** When this entry was created/updated */
  timestamp: number
}

// ── Cache ───────────────────────────────────────────────────────

export class TextureCache {
  private readonly entries = new Map<string, TextureEntry>()
  private readonly byHash = new Map<string, TextureEntry>()

  /**
   * Register a texture definition. If a texture with the same hash
   * already exists, returns the existing entry (dedup).
   */
  register(def: TextureDef, hash: string, filePath: string): TextureEntry {
    const existing = this.byHash.get(hash)
    if (existing) return existing

    const entry: TextureEntry = {
      def: { ...def },
      hash,
      filePath,
      timestamp: Date.now(),
    }
    this.entries.set(def.id, entry)
    this.byHash.set(hash, entry)
    return entry
  }

  /** Get a texture by its ID. */
  get(id: string): TextureEntry | undefined {
    return this.entries.get(id)
  }

  /** Check if a texture with the given hash already exists. */
  hasHash(hash: string): boolean {
    return this.byHash.has(hash)
  }

  /** Get all registered textures. */
  all(): TextureEntry[] {
    return [...this.entries.values()]
  }

  /** Clear the cache. */
  clear(): void {
    this.entries.clear()
    this.byHash.clear()
  }

  /** Number of cached textures. */
  get size(): number {
    return this.entries.size
  }

  /**
   * Create a TextureDef from SH3D texture parameters.
   * Does NOT register — caller decides whether to cache.
   */
  static createDef(
    id: string,
    path: string,
    widthPx: number,
    heightPx: number,
    widthCm: number,
    heightCm: number,
    uv: Partial<UvParams> = {},
  ): TextureDef {
    const merged = { ...DEFAULT_UV, ...uv }
    return {
      id,
      path,
      widthPx,
      heightPx,
      widthCm,
      heightCm,
      scale: merged.scale,
      offsetU: merged.offsetU,
      offsetV: merged.offsetV,
      rotation: merged.rotation,
      wrap: merged.wrap,
      fittingArea: merged.fittingArea,
    }
  }
}
