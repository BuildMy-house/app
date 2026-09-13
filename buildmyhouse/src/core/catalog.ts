/**
 * catalog.ts — Furniture catalog types + registry.
 *
 * The catalog is the frozen contract between the UI, the automation layer,
 * and (eventually) the MCP surface. It mirrors the `list_catalog` wire shape
 * from docs/specs/ws-protocol.md:80 plus optional visual metadata that is
 * purely local (thumbnail + model asset paths; never on the wire).
 *
 * Dimensions are centimeters, matching the schema (width/depth/height).
 */

export interface CatalogItem {
  /** Stable id, e.g. "sofa-3-seater". Referenced by furniture.catalogId. */
  catalogId: string
  name: string
  /** SH3D-style category, e.g. "Living", "Bedroom", "Doors". */
  category: string
  width: number
  depth: number
  height: number
  /** Base elevation of the piece (cm). */
  elevation?: number
  /** Doors/windows behave differently in wall tools (schema doorOrWindow). */
  doorOrWindow?: boolean
  /** Default color as 0xRRGGBB. */
  color?: number | null
  /** Optional local 3D model asset path (relative to the bundle root). */
  model?: string | null
  /** Optional local thumbnail asset path (relative to the bundle root). */
  thumbnail?: string | null
  /**
   * Optional 3D model asset path, relative to `public/assets/`
   * (e.g. "models/sofa.glb"). When present, the 3D view loads this model
   * instead of a colored box. No catalog items ship a model yet — the field
   * exists for future model authors. Never fetched over the network.
   */
  modelPath?: string | null
  /** Free-text search tags (local only). */
  tags?: string[]
}

export interface CatalogManifest {
  schemaVersion: 1
  items: CatalogItem[]
}

/** Catalog categories in canonical display order. */
export const CATALOG_CATEGORIES = [
  'Living',
  'Bedroom',
  'Kitchen',
  'Bathroom',
  'Dining',
  'Office',
  'Doors',
  'Windows',
  'Outdoor',
] as const

export function categoryOf(item: CatalogItem): string {
  return CATALOG_CATEGORIES.includes(item.category as (typeof CATALOG_CATEGORIES)[number])
    ? item.category
    : 'Other'
}

/**
 * Pure catalog registry. Loaded once from a manifest; exposes lookups used by
 * the automation layer and the UI. No platform imports — fully testable.
 */
export class FurnitureCatalog {
  private readonly byId = new Map<string, CatalogItem>()
  private readonly byCategory = new Map<string, CatalogItem[]>()
  private readonly all: CatalogItem[]

  constructor(items: CatalogItem[]) {
    this.all = [...items]
    for (const item of items) {
      if (this.byId.has(item.catalogId)) {
        throw new Error(`duplicate catalogId in manifest: ${item.catalogId}`)
      }
      this.byId.set(item.catalogId, item)
      const category = categoryOf(item)
      const list = this.byCategory.get(category)
      if (list) list.push(item)
      else this.byCategory.set(category, [item])
    }
  }

  get size(): number {
    return this.all.length
  }

  list(): CatalogItem[] {
    return this.all.map((item) => ({ ...item }))
  }

  categories(): string[] {
    return [...this.byCategory.keys()]
  }

  itemsIn(category: string): CatalogItem[] {
    return (this.byCategory.get(category) ?? []).map((item) => ({ ...item }))
  }

  get(catalogId: string): CatalogItem | undefined {
    const item = this.byId.get(catalogId)
    return item ? { ...item } : undefined
  }

  /** Case-insensitive substring search over name/category/tags. */
  search(query: string): CatalogItem[] {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return this.list()
    return this.all
      .filter((item) => {
        if (item.name.toLowerCase().includes(q)) return true
        if (item.category.toLowerCase().includes(q)) return true
        return (item.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
      })
      .map((item) => ({ ...item }))
  }
}
