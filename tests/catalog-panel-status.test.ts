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
