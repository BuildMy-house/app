import {
  getDefaultFloorColor,
  getDefaultFloorShininess,
  getDefaultCeilingColor,
  getDefaultCeilingVisibility,
  WALL_TEXTURES,
  type HomePreferences,
} from '../core/home'
import type { HomeStore } from '../core/store'
import { colorIntToHex, hexToIntColor } from './preferences'
import { notifyScenePreferenceChange } from '../view3d/watch'

const DEFAULTS = {
  floorColor: 0xf0f0f0,
  floorShininess: 0,
  ceilingColor: 0xffffff,
  ceilingVisible: undefined,
}

export function patchHomePreferences(
  store: HomeStore,
  patch: Partial<HomePreferences>,
): void {
  store.patchNonUndoable((h) => {
    const base: HomePreferences = h.preferences ?? {
      defaultFloorColor: 0xf0f0f0,
      defaultFloorShininess: 0,
      defaultCeilingColor: 0xffffff,
    }
    h.preferences = { ...base, ...patch }
  })
  // MAT-T10C: patchNonUndoable() carries this edit past computeSceneUpdates()
  // unnoticed (it only diffs walls/furniture/rooms/levels) — the 3D view
  // would otherwise keep showing the previous defaults until an unrelated
  // structural edit or a full reload. Explicit signal instead of observing
  // patchNonUndoable generically (see view3d/watch.ts).
  notifyScenePreferenceChange()
}

export class MaterialsPreferencesPanel {
  private store: HomeStore
  private container: HTMLElement | null = null
  private floorColor: number
  private floorShininess: number
  private ceilingColor: number
  private ceilingVisible: boolean | undefined
  private interiorWallTextureId: string | null | undefined
  private exteriorWallTextureId: string | null | undefined

  constructor(store: HomeStore) {
    this.store = store
    const home = store.getHome()
    this.floorColor = getDefaultFloorColor(home)
    this.floorShininess = getDefaultFloorShininess(home)
    this.ceilingColor = getDefaultCeilingColor(home)
    this.ceilingVisible = getDefaultCeilingVisibility(home)
    this.interiorWallTextureId = home.preferences?.defaultInteriorWallTextureId
    this.exteriorWallTextureId = home.preferences?.defaultExteriorWallTextureId
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
        <select id="mat-ceiling-visible">
          <option value="auto" ${this.ceilingMode() === 'auto' ? 'selected' : ''}>Auto (per view)</option>
          <option value="show" ${this.ceilingMode() === 'show' ? 'selected' : ''}>Always show</option>
          <option value="hide" ${this.ceilingMode() === 'hide' ? 'selected' : ''}>Always hide</option>
        </select>
      </div>
      <div class="prefs-row">
        <label for="mat-interior-wall-texture">Default Interior Wall Material</label>
        <select id="mat-interior-wall-texture"></select>
      </div>
      <div class="prefs-row">
        <label for="mat-exterior-wall-texture">Default Exterior Wall Material</label>
        <select id="mat-exterior-wall-texture"></select>
      </div>
    `
    this.fillTextureSelect('mat-interior-wall-texture', 'interior', this.interiorWallTextureId)
    this.fillTextureSelect('mat-exterior-wall-texture', 'exterior', this.exteriorWallTextureId)
    this.wireControls()
  }

  private fillTextureSelect(id: string, usage: 'interior' | 'exterior', current: string | null | undefined): void {
    const select = this.container!.querySelector<HTMLSelectElement>(`#${id}`)!
    const selected = current === undefined ? '' : current === null ? 'none' : current
    const add = (value: string, label: string) => {
      const opt = document.createElement('option')
      opt.value = value
      opt.textContent = label
      opt.selected = value === selected
      select.appendChild(opt)
    }
    add('', '(default: plaster-white)')
    add('none', '— none —')
    const currentEntry = current ? WALL_TEXTURES.find((t) => t.id === current) : undefined
    if (currentEntry) add(currentEntry.id, currentEntry.label)
    for (const t of WALL_TEXTURES) {
      if (t.id === currentEntry?.id) continue
      if (t.wallUsage && !t.wallUsage.includes(usage)) continue
      add(t.id, t.label)
    }
  }

  private ceilingMode(): 'show' | 'hide' | 'auto' {
    return this.ceilingVisible === true ? 'show' : this.ceilingVisible === false ? 'hide' : 'auto'
  }

  private wireControls(): void {
    if (!this.container) return
    const floorColorInput = this.container.querySelector<HTMLInputElement>('#mat-floor-color')!
    const floorShininessInput = this.container.querySelector<HTMLInputElement>('#mat-floor-shininess')!
    const ceilingColorInput = this.container.querySelector<HTMLInputElement>('#mat-ceiling-color')!
    const ceilingVisibleInput = this.container.querySelector<HTMLSelectElement>('#mat-ceiling-visible')!
    const shininessLabel = this.container.querySelector<HTMLSpanElement>('.mat-shininess-label')!
    const interiorTextureInput = this.container.querySelector<HTMLSelectElement>('#mat-interior-wall-texture')!
    const exteriorTextureInput = this.container.querySelector<HTMLSelectElement>('#mat-exterior-wall-texture')!

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
      const mode = ceilingVisibleInput.value
      this.ceilingVisible = mode === 'show' ? true : mode === 'hide' ? false : undefined
    })
    interiorTextureInput.addEventListener('change', () => {
      const v = interiorTextureInput.value
      this.interiorWallTextureId = v === '' ? undefined : v === 'none' ? null : v
    })
    exteriorTextureInput.addEventListener('change', () => {
      const v = exteriorTextureInput.value
      this.exteriorWallTextureId = v === '' ? undefined : v === 'none' ? null : v
    })
  }

  apply(): void {
    patchHomePreferences(this.store, {
      defaultFloorColor: this.floorColor,
      defaultFloorShininess: this.floorShininess,
      defaultCeilingColor: this.ceilingColor,
      defaultCeilingVisibility: this.ceilingVisible,
      defaultInteriorWallTextureId: this.interiorWallTextureId,
      defaultExteriorWallTextureId: this.exteriorWallTextureId,
    })
  }

  reset(): void {
    this.floorColor = DEFAULTS.floorColor
    this.floorShininess = DEFAULTS.floorShininess
    this.ceilingColor = DEFAULTS.ceilingColor
    this.ceilingVisible = DEFAULTS.ceilingVisible
    this.interiorWallTextureId = undefined
    this.exteriorWallTextureId = undefined
    if (this.container) this.render(this.container)
  }
}
