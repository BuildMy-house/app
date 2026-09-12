import type { WallLoop } from '../core/wall-loop-detector'

/**
 * Confirmation dialog shown when the wall-loop detector finds a closed loop
 * during wall drawing. Asks the user whether to create a room from the loop.
 *
 * Mirrors the prefs-overlay pattern used by AuthDialog, PreferencesDialog, etc.
 */
export class AutoFloorDialog {
  private overlay: HTMLDivElement
  private loopInfo: WallLoop
  private onConfirm: () => void
  private onCancel: () => void
  private escHandler: ((e: KeyboardEvent) => void) | null = null

  constructor(
    loopInfo: WallLoop,
    onConfirm: () => void,
    onCancel: () => void,
  ) {
    this.loopInfo = loopInfo
    this.onConfirm = onConfirm
    this.onCancel = onCancel
    this.overlay = document.createElement('div')
    this.overlay.className = 'prefs-overlay'
  }

  open(): void {
    const verts = this.loopInfo.vertices.length
    const area = this.loopInfo.area
    // Convert area from cm² to a human-readable display (2 decimal places)
    const areaDisplay = area < 100 ? area.toFixed(1) : Math.round(area)

    this.overlay.innerHTML = `
      <div class="prefs-dialog auto-floor-dialog">
        <h3>Create room from closed walls?</h3>
        <div class="prefs-row">
          <span class="auto-floor-info">Detected a closed loop with <strong>${verts} vertices</strong> and an area of <strong>${areaDisplay} cm²</strong>.</span>
        </div>
        <div class="prefs-actions">
          <button type="button" class="prefs-btn prefs-cancel">Cancel</button>
          <button type="button" class="prefs-btn auto-floor-confirm">Create</button>
        </div>
      </div>
    `
    document.body.appendChild(this.overlay)

    this.overlay.querySelector('.prefs-cancel')!.addEventListener('click', () => this.close())
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close()
    })
    this.overlay.querySelector('.auto-floor-confirm')!.addEventListener('click', () => {
      this.close()
      this.onConfirm()
    })

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
    this.onCancel()
  }
}
