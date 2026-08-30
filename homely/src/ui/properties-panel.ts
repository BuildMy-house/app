import type { HomeStore } from '../core/store'
import { HomeModel } from '../core/model'
import type { Wall, Room, Furniture, NormalizedHomeState } from '../core/home'
import { WALL_TEXTURES } from '../core/home'
import { normalizeAngle } from '../core/export'
import { observeStore } from '../view3d/watch'

function num(v: number | null | undefined, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function validatePositive(raw: string, fallback: number, min = 0.1): number {
  const n = parseFloat(raw)
  return Number.isFinite(n) && n >= min ? n : fallback
}

export function validateFinite(raw: string, fallback: number): number {
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : fallback
}

function hexColor(v: number | null | undefined): string {
  if (v === null || v === undefined) return '#888888'
  const c = v >>> 0
  return '#' + ((c & 0xffffff) >>> 0).toString(16).padStart(6, '0')
}

function parseColor(hex: string): number {
  return parseInt(hex.replace('#', ''), 16)
}

function fieldRow(label: string, input: HTMLElement): HTMLElement {
  const row = document.createElement('div')
  row.className = 'prop-row'
  const lbl = document.createElement('span')
  lbl.className = 'prop-label'
  lbl.textContent = label
  row.appendChild(lbl)
  row.appendChild(input)
  return row
}

function numInput(value: number, opts?: { readonly?: boolean; min?: number; max?: number; step?: number }): HTMLInputElement {
  const el = document.createElement('input')
  el.type = 'number'
  el.className = 'prop-input'
  el.value = String(value)
  el.readOnly = opts?.readonly === true
  if (opts?.min !== undefined) el.setAttribute('min', String(opts.min))
  if (opts?.max !== undefined) el.setAttribute('max', String(opts.max))
  if (opts?.step !== undefined) el.setAttribute('step', String(opts.step))
  return el
}

function textInput(value: string): HTMLInputElement {
  const el = document.createElement('input')
  el.type = 'text'
  el.className = 'prop-input'
  el.value = value
  return el
}

function colorInput(value: number | null | undefined): HTMLInputElement {
  const el = document.createElement('input')
  el.type = 'color'
  el.className = 'prop-color'
  el.value = hexColor(value)
  return el
}

function checkboxInput(checked: boolean): HTMLInputElement {
  const el = document.createElement('input')
  el.type = 'checkbox'
  el.checked = checked
  return el
}

function wallLength(wall: Wall): number {
  return Math.hypot(wall.xEnd - wall.xStart, wall.yEnd - wall.yStart)
}

function wallAngle(wall: Wall): number {
  return Math.atan2(wall.yEnd - wall.yStart, wall.xEnd - wall.xStart) * (180 / Math.PI)
}

function roomArea(room: Room): number {
  let area = 0
  const pts = room.points
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!
    const [x2, y2] = pts[(i + 1) % pts.length]!
    area += x1 * y2 - x2 * y1
  }
  return Math.abs(area) / 2
}

function roomPerimeter(room: Room): number {
  let perim = 0
  const pts = room.points
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!
    const [x2, y2] = pts[(i + 1) % pts.length]!
    perim += Math.hypot(x2 - x1, y2 - y1)
  }
  return perim
}

export class PropertiesPanel {
  private readonly root: HTMLDivElement
  private readonly model: HomeModel
  private readonly unobserve: () => void
  private visible = true

  constructor(store: HomeStore, parent: HTMLElement) {
    this.model = new HomeModel(store)
    this.root = document.createElement('div')
    this.root.id = 'properties-panel'
    this.root.className = 'properties-panel'
    parent.appendChild(this.root)
    this.unobserve = observeStore(store, () => this.render(store))
    this.render(store)
  }

  toggle(): void {
    this.visible = !this.visible
    this.root.classList.toggle('collapsed', !this.visible)
  }

  destroy(): void {
    this.unobserve()
    this.root.remove()
  }

  private render(store: HomeStore): void {
    const home = store.getHome()
    const sel = home.selection

    this.root.innerHTML = ''

    if (sel.length === 0) {
      this.root.appendChild(this.placeholder('Nothing selected'))
      return
    }
    if (sel.length > 1) {
      this.root.appendChild(this.placeholder(`${sel.length} objects selected`))
      return
    }

    const id = sel[0]!
    const obj = this.findObject(home, id)
    if (!obj) {
      this.root.appendChild(this.placeholder('Nothing selected'))
      return
    }

    const header = document.createElement('div')
    header.className = 'prop-header'
    header.textContent = obj.kind
    this.root.appendChild(header)

    const body = document.createElement('div')
    body.className = 'prop-body'

    if (obj.kind === 'Wall') this.renderWall(body, obj.item as Wall, store)
    else if (obj.kind === 'Room') this.renderRoom(body, obj.item as Room, store)
    else if (obj.kind === 'Furniture') this.renderFurniture(body, obj.item as Furniture, store)

    this.root.appendChild(body)
  }

  private placeholder(text: string): HTMLDivElement {
    const el = document.createElement('div')
    el.className = 'prop-placeholder'
    el.textContent = text
    return el
  }

  private findObject(home: NormalizedHomeState, id: string): { kind: string; item: Wall | Room | Furniture } | null {
    const w = home.walls.find((w) => w.id === id)
    if (w) return { kind: 'Wall', item: w }
    const r = home.rooms.find((r) => r.id === id)
    if (r) return { kind: 'Room', item: r }
    const f = home.furniture.find((f) => f.id === id)
    if (f) return { kind: 'Furniture', item: f }
    return null
  }

  private renderWall(body: HTMLDivElement, wall: Wall, _store: HomeStore): void {
    const commit = (patch: Partial<Omit<Wall, 'id'>>) => {
      this.model.updateWall(wall.id, patch)
    }

    // Start point
    const startGroup = this.group('Start')
    const sxInput = numInput(num(wall.xStart), { step: 0.01 })
    sxInput.addEventListener('change', () => {
      const n = validateFinite(sxInput.value, wall.xStart)
      sxInput.value = String(n)
      commit({ xStart: n })
    })
    const syInput = numInput(num(wall.yStart), { step: 0.01 })
    syInput.addEventListener('change', () => {
      const n = validateFinite(syInput.value, wall.yStart)
      syInput.value = String(n)
      commit({ yStart: n })
    })
    startGroup.appendChild(fieldRow('x', sxInput))
    startGroup.appendChild(fieldRow('y', syInput))
    body.appendChild(startGroup)

    // End point
    const endGroup = this.group('End')
    const exInput = numInput(num(wall.xEnd), { step: 0.01 })
    exInput.addEventListener('change', () => {
      const n = validateFinite(exInput.value, wall.xEnd)
      exInput.value = String(n)
      commit({ xEnd: n })
    })
    const eyInput = numInput(num(wall.yEnd), { step: 0.01 })
    eyInput.addEventListener('change', () => {
      const n = validateFinite(eyInput.value, wall.yEnd)
      eyInput.value = String(n)
      commit({ yEnd: n })
    })
    endGroup.appendChild(fieldRow('x', exInput))
    endGroup.appendChild(fieldRow('y', eyInput))
    body.appendChild(endGroup)

    // Length (read-only)
    const lengthInput = numInput(wallLength(wall), { readonly: true })
    body.appendChild(fieldRow('Length', lengthInput))

    // Height
    const heightInput = numInput(num(wall.height, 250), { min: 1, step: 1 })
    heightInput.addEventListener('change', () => {
      const n = validatePositive(heightInput.value, num(wall.height, 250), 1)
      heightInput.value = String(n)
      commit({ height: n })
    })
    body.appendChild(fieldRow('Height', heightInput))

    // Thickness
    const thickInput = numInput(num(wall.thickness, 7), { min: 0.1, step: 0.1 })
    thickInput.addEventListener('change', () => {
      const n = validatePositive(thickInput.value, num(wall.thickness, 7), 0.1)
      thickInput.value = String(n)
      commit({ thickness: n })
    })
    body.appendChild(fieldRow('Thickness', thickInput))

    // Angle (read-only)
    const angleInput = numInput(wallAngle(wall), { readonly: true })
    body.appendChild(fieldRow('Angle', angleInput))

    // Left color
    const leftColor = colorInput(wall.leftSideColor)
    leftColor.addEventListener('input', () => commit({ leftSideColor: parseColor(leftColor.value) }))
    body.appendChild(fieldRow('Left', leftColor))

    // Right color
    const rightColor = colorInput(wall.rightSideColor)
    rightColor.addEventListener('input', () => commit({ rightSideColor: parseColor(rightColor.value) }))
    body.appendChild(fieldRow('Right', rightColor))

    // Left texture
    const leftTexture = document.createElement('select')
    leftTexture.className = 'prop-input'
    const ltNone = document.createElement('option')
    ltNone.value = ''
    ltNone.textContent = '— none —'
    leftTexture.appendChild(ltNone)
    for (const t of WALL_TEXTURES) {
      const opt = document.createElement('option')
      opt.value = t.id
      opt.textContent = t.label
      if (wall.leftSideTextureId === t.id) opt.selected = true
      leftTexture.appendChild(opt)
    }
    leftTexture.addEventListener('change', () =>
      commit({ leftSideTextureId: leftTexture.value || null }),
    )
    body.appendChild(fieldRow('L Texture', leftTexture))

    // Right texture
    const rightTexture = document.createElement('select')
    rightTexture.className = 'prop-input'
    const rtNone = document.createElement('option')
    rtNone.value = ''
    rtNone.textContent = '— none —'
    rightTexture.appendChild(rtNone)
    for (const t of WALL_TEXTURES) {
      const opt = document.createElement('option')
      opt.value = t.id
      opt.textContent = t.label
      if (wall.rightSideTextureId === t.id) opt.selected = true
      rightTexture.appendChild(opt)
    }
    rightTexture.addEventListener('change', () =>
      commit({ rightSideTextureId: rightTexture.value || null }),
    )
    body.appendChild(fieldRow('R Texture', rightTexture))

    // Level
    const levelText = document.createElement('span')
    levelText.className = 'prop-static'
    levelText.textContent = wall.levelRef ?? '(none)'
    body.appendChild(fieldRow('Level', levelText))
  }

  private renderRoom(body: HTMLDivElement, room: Room, _store: HomeStore): void {
    const commit = (patch: Partial<Omit<Room, 'id'>>) => {
      this.model.updateRoom(room.id, patch)
    }

    // Name
    const nameInput = textInput(room.name ?? '')
    nameInput.addEventListener('change', () => commit({ name: nameInput.value || null }))
    body.appendChild(fieldRow('Name', nameInput))

    // Area (read-only)
    const areaInput = numInput(roomArea(room), { readonly: true, step: 0.01 })
    body.appendChild(fieldRow('Area', areaInput))

    // Perimeter (read-only)
    const perimInput = numInput(roomPerimeter(room), { readonly: true, step: 0.01 })
    body.appendChild(fieldRow('Perimeter', perimInput))

    // Floor visible
    const floorVis = checkboxInput(room.floorVisible !== false)
    floorVis.addEventListener('change', () => commit({ floorVisible: floorVis.checked }))
    body.appendChild(fieldRow('Floor', floorVis))

    // Floor color
    const floorColor = colorInput(room.floorColor)
    floorColor.addEventListener('input', () => commit({ floorColor: parseColor(floorColor.value) }))
    body.appendChild(fieldRow('Floor Color', floorColor))
  }

  private renderFurniture(body: HTMLDivElement, f: Furniture, _store: HomeStore): void {
    const commit = (patch: Partial<Omit<Furniture, 'id'>>) => {
      this.model.updateFurniture(f.id, patch)
    }

    // Name
    const nameInput = textInput(f.name)
    nameInput.addEventListener('change', () => commit({ name: nameInput.value || f.name }))
    body.appendChild(fieldRow('Name', nameInput))

    // Position
    const posGroup = this.group('Position')
    const pxInput = numInput(num(f.x), { step: 0.01 })
    pxInput.addEventListener('change', () => {
      const n = validateFinite(pxInput.value, f.x)
      pxInput.value = String(n)
      commit({ x: n })
    })
    const pyInput = numInput(num(f.y), { step: 0.01 })
    pyInput.addEventListener('change', () => {
      const n = validateFinite(pyInput.value, f.y)
      pyInput.value = String(n)
      commit({ y: n })
    })
    posGroup.appendChild(fieldRow('x', pxInput))
    posGroup.appendChild(fieldRow('y', pyInput))
    body.appendChild(posGroup)

    // Size
    const sizeGroup = this.group('Size')
    const wInput = numInput(num(f.width), { min: 0.1, step: 0.1 })
    wInput.addEventListener('change', () => {
      const n = validatePositive(wInput.value, num(f.width, 1))
      wInput.value = String(n)
      commit({ width: n })
    })
    const dInput = numInput(num(f.depth), { min: 0.1, step: 0.1 })
    dInput.addEventListener('change', () => {
      const n = validatePositive(dInput.value, num(f.depth, 1))
      dInput.value = String(n)
      commit({ depth: n })
    })
    const hInput = numInput(num(f.height), { min: 0.1, step: 0.1 })
    hInput.addEventListener('change', () => {
      const n = validatePositive(hInput.value, num(f.height, 1))
      hInput.value = String(n)
      commit({ height: n })
    })
    sizeGroup.appendChild(fieldRow('W', wInput))
    sizeGroup.appendChild(fieldRow('D', dInput))
    sizeGroup.appendChild(fieldRow('H', hInput))
    body.appendChild(sizeGroup)

    // Angle
    const angleInput = numInput(num(f.angleDeg), { step: 0.01 })
    angleInput.addEventListener('change', () => {
      const n = validateFinite(angleInput.value, f.angleDeg)
      const normalized = normalizeAngle(n)
      angleInput.value = String(normalized)
      commit({ angleDeg: normalized })
    })
    body.appendChild(fieldRow('Angle', angleInput))

    // Color
    const colorIn = colorInput(f.color)
    colorIn.addEventListener('input', () => commit({ color: parseColor(colorIn.value) }))
    body.appendChild(fieldRow('Color', colorIn))

    // Elevation
    const elevInput = numInput(num(f.elevation), { step: 0.01 })
    elevInput.addEventListener('change', () => {
      const n = validateFinite(elevInput.value, f.elevation)
      elevInput.value = String(n)
      commit({ elevation: n })
    })
    body.appendChild(fieldRow('Elevation', elevInput))

    // Visibility
    const visCheck = checkboxInput(f.visible !== false)
    visCheck.addEventListener('change', () => commit({ visible: visCheck.checked }))
    body.appendChild(fieldRow('Visible', visCheck))
  }

  private group(label: string): HTMLDivElement {
    const g = document.createElement('div')
    g.className = 'prop-group'
    const h = document.createElement('div')
    h.className = 'prop-group-label'
    h.textContent = label
    g.appendChild(h)
    return g
  }
}
