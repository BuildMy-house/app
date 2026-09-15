/**
 * catalog-panel.ts — Furniture catalog browser (ticket U7).
 *
 * Left sidebar panel: category list, search box, thumbnail grid, click-to-
 * place. Placing an item arms "place mode": the next click on the plan canvas
 * commits addFurniture at that point, then automatically disarms (SH3D
 * convention: one placement per catalog click). Escape also exits place mode.
 *
 * The panel talks only through the HomeModel (via a placement callback) so it
 * stays independent of the automation layer and MCP surface.
 */

import type { CatalogItem } from '../core/catalog'
import type { FurnitureCatalog } from '../core/catalog'
import { CatalogLazyLoader } from './catalog-lazy-loader'

export interface CatalogPlacement {
  catalogId: string
  name: string
  x: number
  y: number
  angleDeg: number
}

export interface CatalogPanelOptions {
  /** Catalog registry backing the panel. */
  catalog: FurnitureCatalog
  /** Placed by the model; returns the created furniture id. */
  onPlace: (item: CatalogItem, x: number, y: number, angleDeg: number) => string
  /** Called when the user exits place mode (Escape / toggle). */
  onPlaceModeChange?: (active: boolean) => void
  /** Called when the user clicks "Import model…". Implementations open a
   *  file dialog, read a .glb, and refresh the catalog. */
  onImportModel?: () => void
  /** Maps a catalog item's modelPath to a fetchable URL. Defaults to
   *  `assets/<path>`; main.ts maps user blob keys to blob URLs so imported
   *  models get real thumbnails instead of the flat swatch fallback. */
  modelUrlResolver?: (modelPath: string) => string
}

/** Absolute http(s) model paths (e.g. R2-hosted GLBs) pass through unchanged. */
function resolveModelUrl(modelPath: string): string {
  return /^https?:\/\//i.test(modelPath) ? modelPath : `assets/${modelPath}`
}

/**
 * Prebaked thumbnail URL for a resolved model URL (MAT-T9, extended for R2).
 * - Bundled local models: `assets/thumbs/<modelPath>.webp`
 * - External R2 models: `https://.../thumbs/<modelPath>.webp` (lazy-loaded)
 * - User imports (blob:/unmatched http): null → falls back to color swatch
 */
function thumbUrlFor(modelUrl: string, modelPath: string): string | null {
  if (modelUrl.startsWith('https://') || modelUrl.startsWith('http://')) {
    // External R2 model → prebaked WebP thumbnail at same domain/bucket
    // Replace /models/ with /thumbs/ and .glb with .webp
    return modelUrl.replace(/\/models\//, '/thumbs/').replace(/\.glb$/, '.webp')
  }
  if (!modelUrl.startsWith('assets/')) return null
  // Local bundled model → asset thumbs directory
  return `assets/thumbs/${modelPath.replace(/\.[^.]+$/, '')}.webp`
}

/** Virtualization constants — multi-column grid, variable card heights. */
const CARD_GAP = 8 // .catalog-grid gap (style.css)
const WINDOW_BUFFER_ROWS = 3
const ESTIMATED_ROW_HEIGHT = 132 // initial guess; overwritten after first measure

const CATEGORY_ORDER = [
  'Living',
  'Bedroom',
  'Kitchen',
  'Bathroom',
  'Dining',
  'Office',
  'Doors',
  'Windows',
  'Outdoor',
  'Other',
]

export class CatalogPanel {
  private catalog: FurnitureCatalog
  private readonly onPlace: (item: CatalogItem, x: number, y: number, angleDeg: number) => string
  private readonly onPlaceModeChange?: (active: boolean) => void
  private readonly onImportModel?: () => void
  private readonly modelUrlResolver: (modelPath: string) => string

  private root: HTMLDivElement
  private searchInput: HTMLInputElement
  private categoryList: HTMLDivElement
  private grid: HTMLDivElement
  private statusLine: HTMLDivElement

  private activeCategory: string | null = null
  private query = ''
  private armed: CatalogItem | null = null

  // ── Grid virtualization state (MAT-T9) ─────────────────────────────────────
  /** Full filtered item list — search/category always run against ALL items. */
  private filteredItems: CatalogItem[] = []
  /** Mounted card elements by catalogId (catalogIds are unique in a catalog). */
  private cardEls = new Map<string, HTMLButtonElement>()
  private spacerTop: HTMLDivElement | null = null
  private spacerBottom: HTMLDivElement | null = null
  private mountedStart = -1
  private mountedEnd = -1
  /** Cards per grid row — starts as a guess, corrected from the real DOM. */
  private columnsPerRow = 1
  private rowOffsets: number[] = [] // cumulative top-offset for each ROW
  private rowHeights: number[] = [] // measured max card height per ROW
  private cardHeights = new Map<string, number>()
  private lastFilterKey: string | null = null
  private scrollRaf = 0

  // ── Lazy thumbnail loading (R2 optimization) ───────────────────────────────
  private lazyLoader = new CatalogLazyLoader()

  constructor(options: CatalogPanelOptions) {
    this.catalog = options.catalog
    this.onPlace = options.onPlace
    this.onPlaceModeChange = options.onPlaceModeChange
    this.onImportModel = options.onImportModel
    this.modelUrlResolver = options.modelUrlResolver ?? resolveModelUrl

    this.root = document.createElement('div')
    this.root.className = 'catalog-panel'
    this.root.innerHTML = `
      <div class="catalog-resize-handle" title="Drag to resize catalog panel"></div>
      <div class="catalog-header">
        <span>Furniture</span>
        <button class="catalog-import" title="Import a GLB model">+ Import</button>
      </div>
      <div class="catalog-search-wrap">
        <input class="catalog-search" type="search" placeholder="Search furniture…" />
      </div>
      <div class="catalog-categories"></div>
      <div class="catalog-grid"></div>
      <div class="catalog-status">Click a piece to place it</div>
    `
    this.searchInput = this.root.querySelector<HTMLInputElement>('.catalog-search')!
    this.categoryList = this.root.querySelector<HTMLDivElement>('.catalog-categories')!
    this.grid = this.root.querySelector<HTMLDivElement>('.catalog-grid')!
    this.statusLine = this.root.querySelector<HTMLDivElement>('.catalog-status')!

    this.attachResizeHandle()

    const importBtn = this.root.querySelector<HTMLButtonElement>('.catalog-import')!
    importBtn.addEventListener('click', () => {
      if (!this.onImportModel) {
        this.renderStatusMessage('Import not available')
        return
      }
      this.onImportModel()
    })
    this.searchInput.addEventListener('input', () => {
      this.query = this.searchInput.value
      this.renderGrid()
    })
    // Windowing: recompute the mounted range on scroll (rAF-throttled) and
    // when the scrollable area resizes (panel drag, window resize, attach).
    this.grid.addEventListener(
      'scroll',
      () => {
        if (this.scrollRaf) return
        this.scrollRaf = requestAnimationFrame(() => {
          this.scrollRaf = 0
          this.updateWindow()
        })
      },
      { passive: true },
    )
    new ResizeObserver(() => this.updateWindow()).observe(this.grid)
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.disarm()
    })
    this.buildCategories()
    this.renderGrid()
  }

  get element(): HTMLDivElement {
    return this.root
  }

  /** The item currently armed for placement, if any. */
  get armedItem(): CatalogItem | null {
    return this.armed
  }

  /** Place-mode state — the UI enables the placement cursor from this. */
  isArmed(): boolean {
    return this.armed !== null
  }

  /** Arm an item (clicked in the grid). */
  arm(item: CatalogItem): void {
    this.armed = item
    this.renderGrid()
    this.renderStatus()
    this.onPlaceModeChange?.(true)
  }

  /** Exit place mode. */
  disarm(): void {
    if (this.armed === null) return
    this.armed = null
    this.renderGrid()
    this.renderStatus()
    this.onPlaceModeChange?.(false)
  }

  /**
   * Called by the plan canvas on click while armed. Places the item and
   * automatically disarms, returning to selection mode (SH3D convention:
   * place one item at a time; re-click the catalog piece to place another).
   */
  place(x: number, y: number, angleDeg = 0): string | null {
    const item = this.armed
    if (!item) return null
    const id = this.onPlace(item, x, y, angleDeg)
    this.disarm()
    return id
  }

  private attachResizeHandle(): void {
    const handle = this.root.querySelector<HTMLDivElement>('.catalog-resize-handle')!

    const MIN_WIDTH = 320
    const MAX_WIDTH = 560

    // The panel root is not appended to #catalog-host until after the
    // constructor runs, so the host must be resolved lazily at drag time —
    // reading parentElement up front returns null and the handle never works.
    let startX = 0
    let startWidth = 0

    const onMove = (e: MouseEvent): void => {
      const host = this.root.parentElement
      if (!host) return
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + (e.clientX - startX)))
      host.style.width = `${newWidth}px`
    }

    const onUp = (): void => {
      handle.classList.remove('dragging')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    handle.addEventListener('mousedown', (e: MouseEvent) => {
      const host = this.root.parentElement
      if (!host) return
      e.preventDefault()
      startX = e.clientX
      startWidth = host.getBoundingClientRect().width
      handle.classList.add('dragging')
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })
  }

  private buildCategories(): void {
    this.categoryList.innerHTML = ''
    const categories = new Set<string>(CATEGORY_ORDER.filter((c) => this.catalog.categories().includes(c)))
    // Any unknown categories fall to the end.
    for (const category of this.catalog.categories()) categories.add(category)

    const allBtn = document.createElement('button')
    allBtn.className = 'catalog-category'
    allBtn.textContent = 'All'
    allBtn.addEventListener('click', () => {
      this.activeCategory = null
      this.highlightCategories()
      this.renderGrid()
    })
    this.categoryList.appendChild(allBtn)

    for (const category of categories) {
      const btn = document.createElement('button')
      btn.className = 'catalog-category'
      btn.dataset.category = category
      const label = document.createElement('span')
      label.textContent = category
      const count = document.createElement('span')
      count.className = 'catalog-count'
      count.textContent = String(this.catalog.itemsIn(category).length)
      btn.append(label, count)
      btn.addEventListener('click', () => {
        this.activeCategory = this.activeCategory === category ? null : category
        this.highlightCategories()
        this.renderGrid()
      })
      this.categoryList.appendChild(btn)
    }
    this.highlightCategories()
  }

  private highlightCategories(): void {
    for (const btn of this.categoryList.querySelectorAll<HTMLButtonElement>('.catalog-category')) {
      btn.classList.toggle('active', btn.dataset.category === this.activeCategory)
    }
  }

  /**
   * Recompute the filtered item list and rebuild the scroll scaffolding.
   * Search/category run against the FULL item list; only the scrolled-into-
   * view window (+ buffer) is mounted as DOM (MAT-T9 virtualization).
   */
  private renderGrid(): void {
    const items = this.query.length > 0
      ? this.catalog.search(this.query)
      : this.activeCategory === null
        ? this.catalog.list()
        : this.catalog.itemsIn(this.activeCategory)

    const filterKey = `${this.activeCategory ?? ''}|${this.query}`
    const filterChanged = filterKey !== this.lastFilterKey
    this.lastFilterKey = filterKey

    this.filteredItems = items
    this.cardEls.clear()
    this.mountedStart = -1
    this.mountedEnd = -1
    this.rowOffsets = []
    this.rowHeights = []
    this.cardHeights.clear()
    this.grid.innerHTML = ''

    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'catalog-empty'
      empty.textContent = 'No furniture found'
      this.grid.appendChild(empty)
      this.renderStatus()
      return
    }

    this.spacerTop = document.createElement('div')
    this.spacerBottom = document.createElement('div')
    this.spacerTop.className = 'catalog-spacer'
    this.spacerBottom.className = 'catalog-spacer'
    this.grid.append(this.spacerTop, this.spacerBottom)

    // New search/category: jump back to the top (arm/disarm re-renders keep
    // the scroll position so the armed card stays where the user left it).
    if (filterChanged) this.grid.scrollTop = 0
    this.updateWindow(true)
    this.renderStatus()
  }

  /** Number of rows the filtered list occupies at the current column count. */
  private get numRows(): number {
    return Math.ceil(this.filteredItems.length / this.columnsPerRow)
  }

  /** Mount/unmount the card window matching the current scroll position. */
  private updateWindow(force = false): void {
    const n = this.filteredItems.length
    if (n === 0 || !this.spacerTop || !this.spacerBottom) return

    // Ensure per-row cumulative offsets exist (lazily built after cards render).
    if (this.rowOffsets.length !== this.numRows) this.rebuildOffsets()

    const cols = this.columnsPerRow
    const numRows = this.numRows
    const scrollTop = this.grid.scrollTop
    const viewportH = this.grid.clientHeight

    const startRow = this.findVisibleStartRow(scrollTop)
    const endRow = this.findVisibleEndRow(scrollTop + viewportH)

    // Buffer by whole rows, then convert the row range to an item range.
    const visStartRow = Math.max(0, startRow - WINDOW_BUFFER_ROWS)
    const visEndRow = Math.min(numRows, endRow + WINDOW_BUFFER_ROWS)
    const visStart = visStartRow * cols
    const visEnd = Math.min(n, visEndRow * cols)

    // Spacer heights must be recomputed on EVERY pass: a measurement
    // correction (card heights, column count) rebuilds offsets even when
    // the mounted range stays the same, and stale spacers would otherwise
    // linger until the range happened to change.
    const topH = visStartRow > 0
      ? this.rowOffsets[visStartRow - 1]! + this.rowHeights[visStartRow - 1]! + CARD_GAP
      : 0
    const totalH = this.rowOffsets[numRows - 1]! + this.rowHeights[numRows - 1]!
    const bottomH = visEndRow < numRows
      ? totalH - (this.rowOffsets[visEndRow - 1]! + this.rowHeights[visEndRow - 1]! + CARD_GAP)
      : 0
    this.spacerTop.style.height = `${topH}px`
    this.spacerBottom.style.height = `${Math.max(0, bottomH - CARD_GAP)}px`

    const rangeChanged = force || visStart !== this.mountedStart || visEnd !== this.mountedEnd
    if (rangeChanged) {
      this.mountedStart = visStart
      this.mountedEnd = visEnd
      for (const [id, card] of this.cardEls) {
        const index = Number(card.dataset.index)
        if (index < visStart || index >= visEnd) {
          this.lazyLoader.unobserve(card)
          card.remove()
          this.cardEls.delete(id)
        }
      }
      for (let i = visStart; i < visEnd; i++) {
        const item = this.filteredItems[i]!
        if (this.cardEls.has(item.catalogId)) continue
        const card = this.createCard(item, i)
        this.grid.insertBefore(card, this.spacerBottom)
        this.cardEls.set(item.catalogId, card)
        const thumbUrl = card.dataset.thumbUrl
        if (thumbUrl) this.lazyLoader.observe(card, thumbUrl)
      }
    }

    // Measure mounted cards; if real heights or the real column count
    // differ from the current estimates, rebuild offsets and re-run — the
    // estimates only converge, so this recursion is bounded.
    if (this.measureCards()) this.updateWindow()
  }

  /** Binary search over rows: first row whose bottom edge is past `y`. */
  private findVisibleStartRow(y: number): number {
    let lo = 0, hi = this.numRows
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.rowOffsets[mid]! + this.rowHeights[mid]! <= y) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Binary search over rows: last row whose top edge is before `y`. */
  private findVisibleEndRow(y: number): number {
    let lo = 0, hi = this.numRows
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.rowOffsets[mid]! <= y) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private heightOf(i: number): number {
    const id = this.filteredItems[i]?.catalogId
    return id ? (this.cardHeights.get(id) ?? ESTIMATED_ROW_HEIGHT) : ESTIMATED_ROW_HEIGHT
  }

  /**
   * Rebuild cumulative per-row offsets. Row r covers item indices
   * [r*columnsPerRow, min(n, (r+1)*columnsPerRow)); its height is the MAX
   * measured height in the row (CSS grid rows size to their tallest cell).
   */
  private rebuildOffsets(): void {
    const n = this.filteredItems.length
    const cols = Math.max(1, this.columnsPerRow)
    const rows = Math.ceil(n / cols)
    this.rowOffsets = new Array(rows)
    this.rowHeights = new Array(rows)
    let acc = 0
    for (let r = 0; r < rows; r++) {
      const start = r * cols
      const end = Math.min(n, start + cols)
      let h = 0
      for (let i = start; i < end; i++) h = Math.max(h, this.heightOf(i))
      this.rowOffsets[r] = acc
      this.rowHeights[r] = h
      acc += h + CARD_GAP
    }
  }

  /** Measure all mounted cards; returns true if heights or columns changed. */
  private measureCards(): boolean {
    let changed = false
    for (const [id, card] of this.cardEls) {
      const measured = card.offsetHeight
      if (measured > 0 && this.cardHeights.get(id) !== measured) {
        this.cardHeights.set(id, measured)
        changed = true
      }
    }
    if (this.measureColumns()) changed = true
    if (changed) this.rebuildOffsets()
    return changed
  }

  /**
   * Derive the real column count from the DOM: cluster ALL mounted cards'
   * top offsets and take the largest cluster. At most one row in any
   * mounted range can be genuinely partial (the filtered list's very last
   * row, when n isn't divisible by the column count) — every other row is
   * full — so the most populous same-top cluster is always a real full
   * row. Picking the first-iterated card's row instead was wrong: Map
   * iteration order is insertion order, which after mount/unmount cycles
   * need not be visual order, so that card could sit in the partial last
   * row and under-count (e.g. 2 of 3), corrupting all row offsets.
   */
  private measureColumns(): boolean {
    const tops: number[] = []
    for (const card of this.cardEls.values()) {
      const rect = card.getBoundingClientRect()
      if (rect.width === 0) continue
      tops.push(rect.top)
    }
    tops.sort((a, b) => a - b)
    let best = 0
    let run = 0
    let prev = NaN
    for (const top of tops) {
      // Sorted tops within one grid row differ only by float rounding
      // (<<1px); distinct rows differ by >=100px, so a 1px chain tolerance
      // can never bridge two rows.
      run = run > 0 && top - prev <= 1 ? run + 1 : 1
      if (run > best) best = run
      prev = top
    }
    // No row with >= 2 cards (single card mounted, or 1-item filter)
    // carries no column information — keep the current count.
    const cols = Math.max(1, best >= 2 ? best : this.columnsPerRow)
    if (cols !== this.columnsPerRow) {
      this.columnsPerRow = cols
      return true
    }
    return false
  }

  /** Build one catalog card (thumbnail + name + dims). */
  private createCard(item: CatalogItem, index: number): HTMLButtonElement {
    const card = document.createElement('button')
    card.className = 'catalog-card'
    card.dataset.catalogId = item.catalogId
    card.dataset.index = String(index)
    card.classList.toggle('armed', this.armed?.catalogId === item.catalogId)

    let swatch: HTMLElement
    if (item.modelPath) {
      const modelUrl = this.modelUrlResolver(item.modelPath)
      const thumbUrl = thumbUrlFor(modelUrl, item.modelPath)
      if (thumbUrl) {
        const img = document.createElement('img')
        img.className = 'catalog-swatch catalog-thumbnail'
        img.alt = ''
        img.decoding = 'async'

        if (thumbUrl.startsWith('http://') || thumbUrl.startsWith('https://')) {
          // External R2 thumbnail: lazy-load when card enters viewport.
          // Start with no src to avoid parallel 1509 fetches; lazy loader will
          // populate it as card becomes visible.
          img.src = '' // Placeholder until lazy loader sets it
          img.loading = 'lazy'
          card.dataset.thumbUrl = thumbUrl
          // Lazy loading will be hooked in updateWindow() when card mounts
        } else {
          // Local bundled thumbnail: use native lazy loading for <img>
          img.src = thumbUrl
          img.loading = 'lazy'
          img.addEventListener('error', () => {
            // Missing/unrenderable thumb: show color swatch (no WebGL for
            // remote URLs — CORS/bridge crashes the renderer).
            const fallback = document.createElement('canvas')
            fallback.className = 'catalog-swatch'
            fallback.width = 96
            fallback.height = 96
            const ctx = fallback.getContext('2d')
            if (ctx) {
              ctx.fillStyle = colorCss(item.color)
              ctx.fillRect(0, 0, fallback.width, fallback.height)
            }
            img.replaceWith(fallback)
          })
        }
        swatch = img
      } else {
        // User-imported / remote model: color swatch (WebGL rendering of
        // remote URLs crashes the renderer due to CORS/bridge issues).
        const fallback = document.createElement('canvas')
        fallback.className = 'catalog-swatch'
        fallback.width = 96
        fallback.height = 96
        const ctx = fallback.getContext('2d')
        if (ctx) {
          ctx.fillStyle = colorCss(item.color)
          ctx.fillRect(0, 0, fallback.width, fallback.height)
        }
        swatch = fallback
      }
    } else {
      // No model at all: flat color swatch (existing behavior).
      const canvas = document.createElement('canvas')
      canvas.className = 'catalog-swatch'
      canvas.width = 96
      canvas.height = 96
      const ctx2d = canvas.getContext('2d')
      if (ctx2d) {
        ctx2d.fillStyle = colorCss(item.color)
        ctx2d.fillRect(0, 0, canvas.width, canvas.height)
      }
      swatch = canvas
    }

    const name = document.createElement('div')
    name.className = 'catalog-name'
    name.textContent = item.name
    name.title = `${item.name} — ${item.width}×${item.depth}×${item.height} cm`
    // Names wrap freely — variable-height virtualization handles uneven cards.

    const dims = document.createElement('div')
    dims.className = 'catalog-dims'
    dims.textContent = `${item.width}×${item.depth}×${item.height}`

    card.append(swatch, name, dims)
    card.addEventListener('click', () => {
      if (this.armed?.catalogId === item.catalogId) this.disarm()
      else this.arm(item)
    })
    return card
  }

  private renderStatus(): void {
    if (this.armed) {
      this.statusLine.textContent = `Placing: ${this.armed.name} — click the plan to place (Esc to cancel)`
      this.statusLine.classList.add('armed')
    } else {
      this.statusLine.textContent = 'Click a piece to place it'
      this.statusLine.classList.remove('armed')
    }
  }

  /** Show an import/status message on the panel status line (not 'armed'). */
  renderStatusMessage(message: string): void {
    this.statusLine.textContent = message
    this.statusLine.classList.remove('armed')
  }

  /** Replace the backing catalog (e.g. after a user import) and re-render. */
  setCatalog(catalog: FurnitureCatalog): void {
    this.catalog = catalog
    this.buildCategories()
    this.renderGrid()
  }

  /** Clean up resources when the panel is destroyed. */
  dispose(): void {
    this.lazyLoader.dispose()
    cancelAnimationFrame(this.scrollRaf)
  }
}

function colorCss(color: number | null | undefined): string {
  if (color === null || color === undefined) return '#9e9e9e'
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`
}

