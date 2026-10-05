// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { FurnitureCatalog } from '../src/core/catalog'
import type { CatalogItem } from '../src/core/catalog'
import { CatalogPanel } from '../src/ui/catalog-panel'

for (const name of ['IntersectionObserver', 'ResizeObserver']) {
  vi.stubGlobal(
    name,
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  )
}

// Scroll handler is rAF-throttled; run it synchronously like view3d.test.ts.
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
  cb(0)
  return 0
})

const item: CatalogItem = {
  catalogId: 'sofa',
  name: 'Sofa',
  category: 'Living',
  width: 200,
  depth: 90,
  height: 80,
  elevation: 0,
  color: 0x999999,
  tags: [],
}

function makePanel() {
  const panel = new CatalogPanel({ catalog: new FurnitureCatalog([item]), onPlace: () => 'id' })
  const line = panel.element.querySelector<HTMLDivElement>('.catalog-status')!
  return { panel, line }
}

describe('catalog tile badge + dimensions', () => {
  it('renders the category badge and dimensions with cm unit on each tile', () => {
    const { panel } = makePanel()
    const card = panel.element.querySelector<HTMLButtonElement>('.catalog-card')!
    const badge = card.querySelector<HTMLSpanElement>('.catalog-badge')
    const dims = card.querySelector<HTMLDivElement>('.catalog-dims')
    expect(badge?.textContent).toBe('Living')
    expect(dims?.textContent).toBe('200×90×80 cm')
  })
})

describe('catalog placement hint', () => {
  it('shows the placing hint while armed and resets on disarm', () => {
    const { panel, line } = makePanel()
    panel.arm(item)
    expect(line.textContent).toContain('Placing: Sofa')
    panel.disarm()
    expect(line.textContent).toBe('Click a piece to place it')
    expect(line.classList.contains('armed')).toBe(false)
  })

  it('resets after a successful placement', () => {
    const { panel, line } = makePanel()
    panel.arm(item)
    panel.place(0, 0)
    expect(line.textContent).toBe('Click a piece to place it')
  })

  it('clears a stale status message on disarm even when not armed', () => {
    const { panel, line } = makePanel()
    panel.renderStatusMessage('Import failed: nope')
    panel.disarm()
    expect(line.textContent).toBe('Click a piece to place it')
  })

  it('clears a stale status message when the catalog is replaced', () => {
    const { panel, line } = makePanel()
    panel.renderStatusMessage('Import failed: nope')
    panel.setCatalog(new FurnitureCatalog([item]))
    expect(line.textContent).toBe('Click a piece to place it')
  })
})

describe('catalog arm/disarm scroll behavior', () => {
  function makeLargePanel() {
    const items: CatalogItem[] = Array.from({ length: 200 }, (_, i) => ({
      catalogId: `it-${i}`,
      name: `Item ${i}`,
      category: 'Other',
      width: 50,
      depth: 50,
      height: 50,
      elevation: 0,
      color: 0x999999,
      tags: [],
    }))
    const panel = new CatalogPanel({ catalog: new FurnitureCatalog(items), onPlace: () => 'id' })
    const grid = panel.element.querySelector<HTMLDivElement>('.catalog-grid')!
    return { panel, grid, items }
  }

  function scrollTo(grid: HTMLDivElement, top: number): void {
    grid.scrollTop = top
    grid.dispatchEvent(new Event('scroll'))
  }

  it('arm/disarm toggles the card class without rebuilding the grid or resetting scroll', () => {
    const { panel, grid, items } = makeLargePanel()
    scrollTo(grid, 5000)
    const card = grid.querySelector<HTMLButtonElement>('.catalog-card')!
    expect(card).toBeTruthy()
    const armed = items.find((i) => i.catalogId === card.dataset.catalogId)!
    const before = grid.scrollTop

    panel.arm(armed)
    expect(grid.scrollTop).toBe(before)
    expect(grid.contains(card)).toBe(true)
    expect(card.classList.contains('armed')).toBe(true)
    expect(grid.querySelectorAll('.catalog-card.armed')).toHaveLength(1)

    panel.disarm()
    expect(grid.scrollTop).toBe(before)
    expect(card.classList.contains('armed')).toBe(false)

    const card2 = grid.querySelectorAll<HTMLButtonElement>('.catalog-card')[1]!
    const second = items.find((i) => i.catalogId === card2.dataset.catalogId)!
    panel.arm(second)
    expect(grid.scrollTop).toBe(before)
    expect(card.classList.contains('armed')).toBe(false)
    expect(card2.classList.contains('armed')).toBe(true)
  })

  it('toggling .armed is a no-op for cards scrolled out of the window', () => {
    const { panel, grid, items } = makeLargePanel()
    scrollTo(grid, 5000) // window mounts items ~32-39; 100/101 stay unmounted
    panel.arm(items[100]!)
    panel.arm(items[101]!)
    expect(grid.querySelector('.catalog-card.armed')).toBeNull()
  })
})
