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
}

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

  private root: HTMLDivElement
  private searchInput: HTMLInputElement
  private categoryList: HTMLDivElement
  private grid: HTMLDivElement
  private statusLine: HTMLDivElement

  private activeCategory: string | null = null
  private query = ''
  private armed: CatalogItem | null = null

  constructor(options: CatalogPanelOptions) {
    this.catalog = options.catalog
    this.onPlace = options.onPlace
    this.onPlaceModeChange = options.onPlaceModeChange
    this.onImportModel = options.onImportModel

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

  private renderGrid(): void {
    this.grid.innerHTML = ''
    const items = this.query.length > 0
      ? this.catalog.search(this.query)
      : this.activeCategory === null
        ? this.catalog.list()
        : this.catalog.itemsIn(this.activeCategory)

    if (items.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'catalog-empty'
      empty.textContent = 'No furniture found'
      this.grid.appendChild(empty)
      this.renderStatus()
      return
    }

    for (const item of items) {
      const card = document.createElement('button')
      card.className = 'catalog-card'
      card.dataset.catalogId = item.catalogId
      card.classList.toggle('armed', this.armed?.catalogId === item.catalogId)

      const swatch = document.createElement('canvas')
      swatch.className = 'catalog-swatch'
      swatch.width = 96
      swatch.height = 72
      swatch.dataset.modelUrl = item.modelPath ? `assets/${item.modelPath}` : ''
      // Kick off the thumbnail render; falls back to a color swatch.
      if (item.modelPath) {
        renderModelThumbnail(swatch, `assets/${item.modelPath}`, item.color)
      } else {
        const ctx2d = swatch.getContext('2d')
        if (ctx2d) {
          ctx2d.fillStyle = colorCss(item.color)
          ctx2d.fillRect(0, 0, swatch.width, swatch.height)
        }
      }

      const name = document.createElement('div')
      name.className = 'catalog-name'
      name.textContent = item.name
      name.title = `${item.name} — ${item.width}×${item.depth}×${item.height} cm`

      const dims = document.createElement('div')
      dims.className = 'catalog-dims'
      dims.textContent = `${item.width}×${item.depth}×${item.height}`

      card.append(swatch, name, dims)
      card.addEventListener('click', () => {
        if (this.armed?.catalogId === item.catalogId) this.disarm()
        else this.arm(item)
      })
      this.grid.appendChild(card)
    }
    this.renderStatus()
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
}

function colorCss(color: number | null | undefined): string {
  if (color === null || color === undefined) return '#9e9e9e'
  return `#${(color >>> 0).toString(16).padStart(6, '0')}`
}
