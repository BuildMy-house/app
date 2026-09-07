import { DEFAULT_WALL_HEIGHT_CM, GROUND_TEXTURES } from '../core/home'
import { NEW_WALL_THICKNESS_CM } from '../core/model'
import type { HomeStore } from '../core/store'
import { telemetry } from '../telemetry/logger'

export const PREFS_KEY = 'homely-preferences'

export interface Preferences {
  unit: 'cm' | 'inch'
  wallHeightCm: number
  wallThicknessCm: number
  groundColor: string
  groundTextureId: string | null
}

const DEFAULTS: Preferences = {
  unit: 'cm',
  wallHeightCm: DEFAULT_WALL_HEIGHT_CM,
  wallThicknessCm: NEW_WALL_THICKNESS_CM,
  groundColor: '#a8a8a8',
  groundTextureId: null,
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
          <label>Ground appearance</label>
          <div class="prefs-ground-mode">
            <label><input type="radio" name="prefs-ground-mode" value="color" ${!prefs.groundTextureId ? 'checked' : ''} /> Color</label>
            <label><input type="radio" name="prefs-ground-mode" value="texture" ${prefs.groundTextureId ? 'checked' : ''} /> Texture</label>
          </div>
        </div>
        <div class="prefs-row prefs-ground-color-row" style="display:${prefs.groundTextureId ? 'none' : ''}">
          <label for="prefs-ground-color">Ground color</label>
          <input id="prefs-ground-color" type="color" value="${prefs.groundColor}" />
        </div>
        <div class="prefs-row prefs-ground-texture-row" style="display:${prefs.groundTextureId ? '' : 'none'}">
          <label for="prefs-ground-texture">Ground texture</label>
          <select id="prefs-ground-texture">
            <option value="">None</option>
            ${GROUND_TEXTURES.map((t) => `<option value="${t.id}"${prefs.groundTextureId === t.id ? ' selected' : ''}>${t.label}</option>`).join('')}
          </select>
        </div>
        <div class="prefs-row">
          <label for="prefs-telemetry-tier2">Usage analytics (Tier 2)</label>
          <input id="prefs-telemetry-tier2" type="checkbox" ${telemetry.tier2Enabled ? 'checked' : ''} />
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

    const colorRow = this.overlay.querySelector<HTMLElement>('.prefs-ground-color-row')!
    const textureRow = this.overlay.querySelector<HTMLElement>('.prefs-ground-texture-row')!
    this.overlay.querySelectorAll<HTMLInputElement>('input[name="prefs-ground-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        const isTexture = radio.value === 'texture' && radio.checked
        colorRow.style.display = isTexture ? 'none' : ''
        textureRow.style.display = isTexture ? '' : 'none'
      })
    })

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
    const groundTextureId = this.overlay.querySelector<HTMLSelectElement>('#prefs-ground-texture')?.value || null
    const tier2 = this.overlay.querySelector<HTMLInputElement>('#prefs-telemetry-tier2')?.checked ?? true

    const prefs: Preferences = { unit, wallHeightCm, wallThicknessCm, groundColor, groundTextureId }
    savePreferences(prefs)
    telemetry.setTier2(tier2)
    this.close()
    this.onClose(prefs)
  }
}
