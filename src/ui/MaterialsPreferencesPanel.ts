import {
  getDefaultFloorColor,
  getDefaultFloorShininess,
  getDefaultCeilingColor,
  getDefaultCeilingVisibility,
} from '../core/home'
import type { HomeStore } from '../core/store'
import { colorIntToHex, hexToIntColor } from './preferences'

const DEFAULTS = {
  floorColor: 0xf0f0f0,
  floorShininess: 0,
  ceilingColor: 0xffffff,
  ceilingVisible: true,
}

export class MaterialsPreferencesPanel {
  private store: HomeStore
  private container: HTMLElement | null = null
  private floorColor: number
  private floorShininess: number
  private ceilingColor: number
  private ceilingVisible: boolean

  constructor(store: HomeStore) {
    this.store = store
    const home = store.getHome()
    this.floorColor = getDefaultFloorColor(home)
    this.floorShininess = getDefaultFloorShininess(home)
    this.ceilingColor = getDefaultCeilingColor(home)
    this.ceilingVisible = getDefaultCeilingVisibility(home)
  }

  render(container: HTMLElement): void {
    this.container = container
    container.innerHTML = `
      <h3>Material Preferences</h3>
      <div class="prefs-row">
        <label for="mat-floor-color">Default floor color</label>
        <input id="mat-floor-color" type="color" value="${colorIntToHex(this.floorColor)}" />
      </div>
      <div class="prefs-row">
        <label for="mat-floor-shininess">Floor shininess</label>
        <input id="mat-floor-shininess" type="range" min="0" max="1" step="0.01" value="${this.floorShininess}" />
        <span class="mat-shininess-label">${Math.round(this.floorShininess * 100)}%</span>
      </div>
      <div class="prefs-row">
        <label for="mat-ceiling-color">Default ceiling color</label>
        <input id="mat-ceiling-color" type="color" value="${colorIntToHex(this.ceilingColor)}" />
      </div>
      <div class="prefs-row">
        <label for="mat-ceiling-visible">Ceiling visible</label>
        <input id="mat-ceiling-visible" type="checkbox" ${this.ceilingVisible ? 'checked' : ''} />
      </div>
    `
    this.wireControls()
  }

  private wireControls(): void {
    if (!this.container) return
    const floorColorInput = this.container.querySelector<HTMLInputElement>('#mat-floor-color')!
    const floorShininessInput = this.container.querySelector<HTMLInputElement>('#mat-floor-shininess')!
    const ceilingColorInput = this.container.querySelector<HTMLInputElement>('#mat-ceiling-color')!
    const ceilingVisibleInput = this.container.querySelector<HTMLInputElement>('#mat-ceiling-visible')!
    const shininessLabel = this.container.querySelector<HTMLSpanElement>('.mat-shininess-label')!

    floorColorInput.addEventListener('input', () => {
      this.floorColor = hexToIntColor(floorColorInput.value)
    })
    floorShininessInput.addEventListener('input', () => {
      this.floorShininess = parseFloat(floorShininessInput.value)
      shininessLabel.textContent = `${Math.round(this.floorShininess * 100)}%`
    })
    ceilingColorInput.addEventListener('input', () => {
      this.ceilingColor = hexToIntColor(ceilingColorInput.value)
    })
    ceilingVisibleInput.addEventListener('change', () => {
      this.ceilingVisible = ceilingVisibleInput.checked
    })
  }

  apply(): void {
    this.store.patchNonUndoable((h) => {
      h.preferences = {
        defaultFloorColor: this.floorColor,
        defaultFloorShininess: this.floorShininess,
        defaultCeilingColor: this.ceilingColor,
        defaultCeilingVisibility: this.ceilingVisible,
      }
    })
  }

  reset(): void {
    this.floorColor = DEFAULTS.floorColor
    this.floorShininess = DEFAULTS.floorShininess
    this.ceilingColor = DEFAULTS.ceilingColor
    this.ceilingVisible = DEFAULTS.ceilingVisible
    if (this.container) this.render(this.container)
  }
}
