import type { RemoteHomeSummary } from '../services/adapters/remote-home-store'

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

const formatUpdated = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/**
 * Simple "Open from My Account" picker listing the user's saved homes by name
 * and last-updated time. Reuses the prefs modal styling; picks call onPick
 * with the chosen home id.
 */
export class HomeListDialog {
  private overlay: HTMLDivElement
  private homes: RemoteHomeSummary[]
  private onPick: (id: string) => void
  private escHandler: ((e: KeyboardEvent) => void) | null = null

  constructor(homes: RemoteHomeSummary[], onPick: (id: string) => void) {
    this.homes = homes
    this.onPick = onPick
    this.overlay = document.createElement('div')
    this.overlay.className = 'prefs-overlay'
  }

  open(): void {
    const items = this.homes
      .map(
        (h) => `
          <button type="button" class="home-list-item" data-id="${escapeHtml(h.id)}">
            <span class="home-list-name">${escapeHtml(h.name)}</span>
            <span class="home-list-date">${escapeHtml(formatUpdated(h.updatedAt))}</span>
          </button>`,
      )
      .join('')

    this.overlay.innerHTML = `
      <div class="prefs-dialog home-list-dialog">
        <h3>Open from My Account</h3>
        <div class="home-list">${items}</div>
        <div class="prefs-actions">
          <button type="button" class="prefs-btn prefs-cancel">Cancel</button>
        </div>
      </div>
    `
    document.body.appendChild(this.overlay)

    this.overlay.querySelector('.prefs-cancel')!.addEventListener('click', () => this.close())
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close()
    })
    for (const btn of this.overlay.querySelectorAll<HTMLButtonElement>('.home-list-item')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id
        if (!id) return
        this.close()
        this.onPick(id)
      })
    }
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.close()
      }
    }
    window.addEventListener('keydown', this.escHandler)
  }

  private close(): void {
    if (this.escHandler) {
      window.removeEventListener('keydown', this.escHandler)
      this.escHandler = null
    }
    this.overlay.remove()
  }
}
