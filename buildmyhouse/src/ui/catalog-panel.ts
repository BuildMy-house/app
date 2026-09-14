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
import { renderModelThumbnail } from './model-thumbnail'
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

/** Virtualization constants — single-column grid, uniform card stride. */
const GRID_PADDING = 8 // .catalog-grid padding (style.css)
const CARD_GAP = 8 // .catalog-grid gap (style.css)
const WINDOW_BUFFER_ROWS = 3
const DEFAULT_ROW_STRIDE = 132 // ≈ padding + 56px swatch + 2-line name + dims; re-measured at runtime

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
  private rowStride = DEFAULT_ROW_STRIDE
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
    const host = this.root.parentElement as HTMLElement | null
    if (!host) return

    const MIN_WIDTH = 260
    const MAX_WIDTH = 480

    let startX = 0
    let startWidth = 0

    const onMove = (e: MouseEvent): void => {
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + (e.clientX - startX)))
      host.style.width = `${newWidth}px`
    }

    const onUp = (): void => {
      handle.classList.remove('dragging')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    handle.addEventListener('mousedown', (e: MouseEvent) => {
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

  /** Mount/unmount the card window matching the current scroll position. */
  private updateWindow(force = false): void {
    const n = this.filteredItems.length
    if (n === 0 || !this.spacerTop || !this.spacerBottom) return

    const stride = this.rowStride
    const firstVisible = Math.floor(Math.max(0, this.grid.scrollTop - GRID_PADDING) / stride)
    const viewportRows = Math.ceil(this.grid.clientHeight / stride) + 1
    const start = Math.max(0, firstVisible - WINDOW_BUFFER_ROWS)
    const end = Math.min(n, firstVisible + viewportRows + WINDOW_BUFFER_ROWS)

    if (!force && start === this.mountedStart && end === this.mountedEnd) return
    this.mountedStart = start
    this.mountedEnd = end

    this.spacerTop.style.height = `${start * stride}px`
    this.spacerBottom.style.height = `${Math.max(0, n - end) * stride}px`

    for (const [id, card] of this.cardEls) {
      const index = Number(card.dataset.index)
      if (index < start || index >= end) {
        // Card is leaving viewport: unobserve from lazy loader to free resources
        this.lazyLoader.unobserve(card)
        card.remove()
        this.cardEls.delete(id)
      }
    }
    for (let i = start; i < end; i++) {
      const item = this.filteredItems[i]!
      if (this.cardEls.has(item.catalogId)) continue
      const card = this.createCard(item, i)
      this.grid.insertBefore(card, this.spacerBottom)
      this.cardEls.set(item.catalogId, card)
      // Hook up lazy loading for external R2 thumbnails
      const thumbUrl = card.dataset.thumbUrl
      if (thumbUrl) {
        this.lazyLoader.observe(card, thumbUrl)
      }
    }

    // Cards are uniform-height (2-line clamped names); measure the real
    // stride once laid out and re-window if the estimate was off.
    const first = this.grid.querySelector<HTMLButtonElement>('.catalog-card')
    if (first && this.grid.clientHeight > 0) {
      const measured = first.offsetHeight + CARD_GAP
      if (measured > 0 && Math.abs(measured - stride) > 1) {
        this.rowStride = measured
        this.updateWindow()
      }
    }
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
            // Missing/unrenderable thumb: fall back to live WebGL render.
            const canvas = liveRenderSwatch(modelUrl, item.color)
            img.replaceWith(canvas)
          })
        }
        swatch = img
      } else {
        // User-imported / remote model: live WebGL render with swatch fallback.
        swatch = liveRenderSwatch(modelUrl, item.color)
      }
    } else {
      // No model at all: flat color swatch (existing behavior).
      const canvas = document.createElement('canvas')
      canvas.className = 'catalog-swatch'
      canvas.width = 96
      canvas.height = 72
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
    // Cap names at 2 lines so every card has the same height — the
    // virtualization stride math depends on uniform rows. Vertical clamp
    // only; horizontal overflow is forbidden by the label-clipping e2e.
    name.style.display = '-webkit-box'
    name.style.webkitLineClamp = '2'
    name.style.webkitBoxOrient = 'vertical'
    name.style.overflow = 'hidden'
    name.style.height = '2.7em' // 2 × line-height (1.35)

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

/**
 * Live WebGL thumbnail fallback (MAT-T9): used for user-imported models and
 * any bundled item whose prebaked WebP is missing. Draws the color swatch
 * immediately, then renders the GLB over it via the shared renderer.
 */
function liveRenderSwatch(modelUrl: string, color: number | null | undefined): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.className = 'catalog-swatch'
  canvas.width = 96
  canvas.height = 72
  canvas.dataset.modelUrl = modelUrl
  renderModelThumbnail(canvas, modelUrl, color)
  return canvas
}
