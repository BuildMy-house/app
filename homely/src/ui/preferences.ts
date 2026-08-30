import { DEFAULT_WALL_HEIGHT_CM } from '../core/home'
import { NEW_WALL_THICKNESS_CM } from '../core/model'
import type { HomeStore } from '../core/store'

export const PREFS_KEY = 'homely-preferences'

export interface Preferences {
  unit: 'cm' | 'inch'
  wallHeightCm: number
  wallThicknessCm: number
  groundColor: string
}

const DEFAULTS: Preferences = {
  unit: 'cm',
  wallHeightCm: DEFAULT_WALL_HEIGHT_CM,
  wallThicknessCm: NEW_WALL_THICKNESS_CM,
  groundColor: '#a8a8a8',
}

export function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function savePreferences(prefs: Preferences): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
}

export function colorIntToHex(n: number | null): string {
  if (n === null) return '#a8a8a8'
  const clamped = n & 0xffffff
  return '#' + clamped.toString(16).padStart(6, '0')
}

export function hexToIntColor(hex: string): number {
  return parseInt(hex.replace('#', ''), 16)
}

export type PrefsChangeHandler = (prefs: Preferences) => void

export class PreferencesDialog {
  private overlay: HTMLDivElement
  private onClose: PrefsChangeHandler
  private store: HomeStore

  constructor(store: HomeStore, onClose: PrefsChangeHandler) {
    this.store = store
    this.onClose = onClose
    this.overlay = document.createElement('div')
    this.overlay.className = 'prefs-overlay'
  }

  open(): void {
    const prefs = loadPreferences()
    this.overlay.innerHTML = `
      <div class="prefs-dialog">
        <h3>Preferences</h3>
        <div class="prefs-row">
          <label for="prefs-unit">Unit</label>
          <select id="prefs-unit">
            <option value="cm"${prefs.unit === 'cm' ? ' selected' : ''}>Centimeters</option>
            <option value="inch"${prefs.unit === 'inch' ? ' selected' : ''}>Inches</option>
          </select>
        </div>
        <div class="prefs-row">
          <label for="prefs-wall-height">Default wall height (cm)</label>
          <input id="prefs-wall-height" type="number" min="10" max="1000" step="1" value="${prefs.wallHeightCm}" />
        </div>
        <div class="prefs-row">
          <label for="prefs-wall-thickness">Default wall thickness (cm)</label>
          <input id="prefs-wall-thickness" type="number" min="1" max="100" step="0.5" value="${prefs.wallThicknessCm}" />
        </div>
        <div class="prefs-row">
          <label for="prefs-ground-color">Ground color</label>
          <input id="prefs-ground-color" type="color" value="${prefs.groundColor}" />
        </div>
        <div class="prefs-actions">
          <button class="prefs-btn prefs-cancel">Cancel</button>
          <button class="prefs-btn prefs-ok">OK</button>
        </div>
      </div>
    `
    document.body.appendChild(this.overlay)

    this.overlay.querySelector('.prefs-cancel')!.addEventListener('click', () => this.close())
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close()
    })
    this.overlay.querySelector('.prefs-ok')!.addEventListener('click', () => this.apply())

    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        this.close()
      }
    }
    this.overlay.addEventListener('keydown', escHandler)
    this._escHandler = escHandler
  }

  private _escHandler: ((e: KeyboardEvent) => void) | null = null

  private close(): void {
    if (this._escHandler) {
      window.removeEventListener('keydown', this._escHandler)
      this._escHandler = null
    }
    this.overlay.remove()
  }

  private apply(): void {
    const unit = (this.overlay.querySelector<HTMLSelectElement>('#prefs-unit')?.value ?? 'cm') as 'cm' | 'inch'
    const wallHeightCm = Number(this.overlay.querySelector<HTMLInputElement>('#prefs-wall-height')?.value) || DEFAULT_WALL_HEIGHT_CM
    const wallThicknessCm = Number(this.overlay.querySelector<HTMLInputElement>('#prefs-wall-thickness')?.value) || NEW_WALL_THICKNESS_CM
    const groundColor = this.overlay.querySelector<HTMLInputElement>('#prefs-ground-color')?.value ?? '#a8a8a8'

    const prefs: Preferences = { unit, wallHeightCm, wallThicknessCm, groundColor }
    savePreferences(prefs)
    this.close()
    this.onClose(prefs)
  }
}
