import type { RemoteHomeSummary } from '../services/adapters/remote-home-store'
import { confirmDialog, promptDialog } from './dialogs'

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

const formatUpdated = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export interface HomeListDialogOptions {
  onPick: (id: string) => void
  /** Rename a project; resolves once the server confirms. Omit to hide the control. */
  onRename?: (id: string, name: string) => Promise<void>
  /** Delete a project; resolves once the server confirms. Omit to hide the control. */
  onDelete?: (id: string) => Promise<void>
}

/**
 * "My Projects" manager: lists the user's saved homes with last-updated time,
 * and (when the caller wires them) rename/delete actions alongside the pick
 * action. Reuses the prefs modal styling.
 */
export class HomeListDialog {
  private overlay: HTMLDivElement
  private homes: RemoteHomeSummary[]
  private options: HomeListDialogOptions
  private escHandler: ((e: KeyboardEvent) => void) | null = null

  constructor(homes: RemoteHomeSummary[], onPickOrOptions: ((id: string) => void) | HomeListDialogOptions) {
    this.homes = homes
    this.options = typeof onPickOrOptions === 'function' ? { onPick: onPickOrOptions } : onPickOrOptions
    this.overlay = document.createElement('div')
    this.overlay.className = 'prefs-overlay'
  }

  open(): void {
    this.render()
    document.body.appendChild(this.overlay)
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.close()
      }
    }
    window.addEventListener('keydown', this.escHandler)
  }

  private render(): void {
    const { onRename, onDelete } = this.options
    const items = this.homes
      .map(
        (h) => `
          <div class="home-list-item" data-id="${escapeHtml(h.id)}">
            <button type="button" class="home-list-open">
              <span class="home-list-name">${escapeHtml(h.name)}</span>
              <span class="home-list-date">${escapeHtml(formatUpdated(h.updatedAt))}</span>
            </button>
            <div class="home-list-item-actions">
              ${onRename ? '<button type="button" class="home-list-rename" title="Rename">Rename</button>' : ''}
              ${onDelete ? '<button type="button" class="home-list-delete" title="Delete">Delete</button>' : ''}
            </div>
          </div>`,
      )
      .join('')

    this.overlay.innerHTML = `
      <div class="prefs-dialog home-list-dialog">
        <h3>My Projects</h3>
        <div class="home-list">${items || '<p class="home-list-empty">No saved projects yet.</p>'}</div>
        <div class="prefs-actions">
          <button type="button" class="prefs-btn prefs-cancel">Close</button>
        </div>
      </div>
    `
    this.overlay.querySelector('.prefs-cancel')!.addEventListener('click', () => this.close())
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close()
    })

    for (const row of this.overlay.querySelectorAll<HTMLDivElement>('.home-list-item')) {
      const id = row.dataset.id
      if (!id) continue

      row.querySelector('.home-list-open')!.addEventListener('click', () => {
        this.close()
        this.options.onPick(id)
      })

      row.querySelector('.home-list-rename')?.addEventListener('click', async (e) => {
        e.stopPropagation()
        const home = this.homes.find((h) => h.id === id)
        const next = await promptDialog('New project name:', home?.name ?? '')
        if (next === null) return
        const trimmed = next.trim()
        if (!trimmed || !this.options.onRename) return
        await this.options.onRename(id, trimmed)
        if (home) home.name = trimmed
        this.render()
      })

      row.querySelector('.home-list-delete')?.addEventListener('click', async (e) => {
        e.stopPropagation()
        const home = this.homes.find((h) => h.id === id)
        if (!(await confirmDialog(`Delete "${home?.name ?? 'this project'}"? This cannot be undone.`))) return
        if (!this.options.onDelete) return
        await this.options.onDelete(id)
        this.homes = this.homes.filter((h) => h.id !== id)
        this.render()
      })
    }
  }

  private close(): void {
    if (this.escHandler) {
      window.removeEventListener('keydown', this.escHandler)
      this.escHandler = null
    }
    this.overlay.remove()
  }
}
