import './style.css'
import { AutomationClient, automationPortFromSearch } from './automation/client'
import type { ClientStatus } from './automation/client'
import { HomeStore } from './core/store'
import { HomeModel } from './core/model'
import { HomelyCommandHandler } from './automation/homely-handler'
import { FurnitureCatalog } from './core/catalog'
import { loadDefaultCatalog } from './core/catalog-service'
import { CatalogPanel } from './ui/catalog-panel'
import { PlanEngine, type PlanPreview, type PlanTool } from './plan/engine'
import { snapFurniturePlacement } from './plan/furniture-snap'
import { ViewMapper, drawPlan, fitToBounds, type PlanRenderingContext, type ViewTransform } from './plan/renderer'
import { saveHomeFile, loadHomeFile } from './services/adapters/home-persistence'
import { exportPlanPng, export3dPng } from './services/adapters/plan-export'
import { PreferencesDialog, loadPreferences, hexToIntColor } from './ui/preferences'
import { ClipboardManager } from './plan/clipboard'

import { View3D, type CameraPresetName } from './view3d'
import { PropertiesPanel } from './ui/properties-panel'

// ── DOM shell ───────────────────────────────────────────────────────────────

const root = document.querySelector<HTMLDivElement>('#root')!

root.innerHTML = `
  <div id="menu-bar"></div>
  <div id="toolbar"></div>
  <div id="main-area">
    <div id="catalog-host"></div>
    <div id="plan-panel" class="panel">
      <canvas id="plan-canvas"></canvas>
    </div>
    <div id="divider"></div>
    <div id="view3d-panel" class="panel">
      <div id="view3d"></div>
    </div>
  </div>
  <div id="status-bar">
    <span id="status-cursor">x: 0  y: 0</span>
    <span id="status-tool">selection</span>
    <span id="status-zoom">zoom: 100%</span>
    <span id="status-automation">automation: idle</span>
  </div>
`

const menuBar = root.querySelector<HTMLDivElement>('#menu-bar')!
const toolbar = root.querySelector<HTMLDivElement>('#toolbar')!
const catalogHost = root.querySelector<HTMLDivElement>('#catalog-host')!
const planPanel = root.querySelector<HTMLDivElement>('#plan-panel')!
const view3dPanel = root.querySelector<HTMLDivElement>('#view3d-panel')!
const divider = root.querySelector<HTMLDivElement>('#divider')!
const canvas = root.querySelector<HTMLCanvasElement>('#plan-canvas')!
const statusCursor = root.querySelector<HTMLSpanElement>('#status-cursor')!
const statusTool = root.querySelector<HTMLSpanElement>('#status-tool')!
const statusZoom = root.querySelector<HTMLSpanElement>('#status-zoom')!
const statusAutomation = root.querySelector<HTMLSpanElement>('#status-automation')!
const ctx = canvas.getContext('2d')

// ── Store + engine ──────────────────────────────────────────────────────────

const store = new HomeStore()
const model = new HomeModel(store)
const engine = new PlanEngine(model)
const clipboardManager = new ClipboardManager(store, model)

// Apply stored preferences (wall defaults, ground color).
const bootPrefs = loadPreferences()
engine.setWallDefaults(bootPrefs.wallHeightCm, bootPrefs.wallThicknessCm)
store.patchNonUndoable((h) => {
  h.environment.groundColor = hexToIntColor(bootPrefs.groundColor)
})

// Catalog panel — declared here (used by canvas/key closures) and
// instantiated in boot once the DOM host exists.
let catalogPanel: CatalogPanel | null = null

// User-imported models resolve through blob URLs; bundled models through
// `assets/<path>`. Declared before View3D (used in its options).
const userModelUrls = new Map<string, string>()
const modelUrlResolver = (modelPath: string): string => {
  const blobUrl = userModelUrls.get(modelPath)
  return blobUrl ?? `assets/${modelPath}`
}

// 3D view — assigned in boot (after the DOM shell exists). Declared up here so
// toolbar/refresh closures can reference it before assignment without a TDZ error.
let view3d: View3D | null = null

let automationText = 'idle'
let currentView: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 }
let spaceHeld = false
let isPanning = false
let panLastX = 0
let panLastY = 0
let activeLevelId: string | null = null

const ZOOM_MIN = 0.1
const ZOOM_MAX = 10.0

// ── Menu bar ────────────────────────────────────────────────────────────────

interface MenuDef {
  label: string
  items: Array<{ label: string; shortcut?: string; action?: () => void; disabled?: boolean }>
}

function buildMenu(menus: MenuDef[]): void {
  menuBar.innerHTML = ''
  for (const menu of menus) {
    const item = document.createElement('div')
    item.className = 'menu-item'

    const trigger = document.createElement('button')
    trigger.className = 'menu-trigger'
    trigger.textContent = menu.label

    const dropdown = document.createElement('div')
    dropdown.className = 'menu-dropdown'

    for (const entry of menu.items) {
      if (entry.label === '---') {
        const sep = document.createElement('div')
        sep.className = 'menu-separator'
        dropdown.appendChild(sep)
        continue
      }
      const btn = document.createElement('button')
      btn.className = 'menu-entry'
      if (entry.disabled) btn.disabled = true
      const labelSpan = document.createElement('span')
      labelSpan.textContent = entry.label
      btn.appendChild(labelSpan)
      if (entry.shortcut) {
        const kbd = document.createElement('span')
        kbd.className = 'menu-shortcut'
        kbd.textContent = entry.shortcut
        btn.appendChild(kbd)
      }
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        closeAllMenus()
        entry.action?.()
      })
      dropdown.appendChild(btn)
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation()
      const wasOpen = item.classList.contains('open')
      closeAllMenus()
      if (!wasOpen) item.classList.add('open')
    })

    item.appendChild(trigger)
    item.appendChild(dropdown)
    menuBar.appendChild(item)
  }
}

function closeAllMenus(): void {
  menuBar.querySelectorAll('.menu-item.open').forEach((el) => el.classList.remove('open'))
}

document.addEventListener('click', closeAllMenus)

const hasUndo = () => store.canUndo()
const hasRedo = () => store.canRedo()

function refreshMenus(): void {
  buildMenu([
    {
      label: 'File',
      items: [
        {
          label: 'New',
          action: () => {
            if (store.isDirty() && !confirm('Unsaved changes will be lost. Continue?')) return
            store.resetToEmpty()
            doFit()
            refreshAll()
          },
        },
        { label: '---' },
        {
          label: 'Save',
          action: async () => {
            try {
              await saveHomeFile(store.getHome())
              store.markClean()
            } catch (err) {
              alert(err instanceof Error ? err.message : `Failed to save home file: ${String(err)}`)
            }
          },
        },
        {
          label: 'Open',
          action: async () => {
            if (store.isDirty() && !confirm('Unsaved changes will be lost. Continue?')) return
            try {
              const home = await loadHomeFile()
              if (home) {
                store.loadHome(home)
                doFit()
                refreshAll()
              }
            } catch (err) {
              alert(err instanceof Error ? err.message : `Failed to load home file: ${String(err)}`)
            }
          },
        },
        { label: '---' },
        { label: 'Export Plan as PNG…', action: () => { exportPlanPng(store.getHome()) } },
        { label: 'Export 3D View as PNG…', action: () => { if (view3d) export3dPng(view3d.scene, view3d.camera) } },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', action: () => { store.undo(); refreshAll() }, disabled: !hasUndo() },
        { label: 'Redo', shortcut: 'Ctrl+Y', action: () => { store.redo(); refreshAll() }, disabled: !hasRedo() },
        { label: '---' },
        { label: 'Delete', action: () => { engine.key('delete'); refreshAll() } },
        { label: 'Select All', action: () => selectAll() },
        { label: '---' },
        { label: 'Copy', shortcut: 'Ctrl+C', action: () => { if (clipboardManager.copy() > 0) refreshAll() } },
        { label: 'Paste', shortcut: 'Ctrl+V', action: () => { if (clipboardManager.paste().length > 0) refreshAll() } },
        { label: 'Duplicate', shortcut: 'Ctrl+D', action: () => { if (clipboardManager.duplicate().length > 0) refreshAll() } },
        { label: '---' },
        { label: 'Preferences…', action: () => openPreferences() },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Plan View', action: () => setCameraPreset('plan') },
        { label: '3D View', action: () => setCameraPreset('3d') },
        { label: 'Split View', action: () => setCameraPreset('split') },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'About Homely', action: () => alert('Homely — Sweet Home 3D clone\nTauri + Three.js + TypeScript') },
      ],
    },
  ])
}

function openPreferences(): void {
  const dialog = new PreferencesDialog(store, (prefs) => {
    engine.setWallDefaults(prefs.wallHeightCm, prefs.wallThicknessCm)
    store.patchNonUndoable((h) => {
      h.environment.groundColor = hexToIntColor(prefs.groundColor)
    })
    refreshAll()
  })
  dialog.open()
}

// ── Toolbar ─────────────────────────────────────────────────────────────────

function buildToolbar(): void {
  toolbar.innerHTML = `
    <div class="tool-group">
      <button class="tool-btn" data-tool="selection" title="Selection (V)">Select</button>
      <button class="tool-btn" data-tool="wall" title="Wall tool (W)">Wall</button>
      <button class="tool-btn" data-tool="room" title="Room tool">Room</button>
      <button class="tool-btn" data-tool="dimensionLine" title="Dimension tool">Dim</button>
      <button class="tool-btn" data-tool="label" title="Text tool">Text</button>
      <button class="tool-btn" id="btn-catalog" title="Furniture catalog (F)">Furniture</button>
    </div>
    <div class="tool-separator"></div>
    <div class="tool-group">
      <button class="tool-btn" id="btn-undo" title="Undo (Ctrl+Z)">Undo</button>
      <button class="tool-btn" id="btn-redo" title="Redo (Ctrl+Y)">Redo</button>
    </div>
    <div class="tool-separator"></div>
    <div class="tool-group" id="level-group">
      <button class="tool-btn" id="btn-level-all" title="Show all levels" data-level="all">All</button>
    </div>
    <div class="tool-separator"></div>
    <label><input id="magnetism" type="checkbox" checked /> Mag</label>
    <div class="toolbar-spacer"></div>
    <button class="tool-btn" id="btn-fit" title="Zoom to fit (double-click middle)">Fit</button>
    <div class="tool-separator"></div>
    <div class="camera-toggle">
      <button class="tool-btn active" data-preset="split" title="Split view">Split</button>
      <button class="tool-btn" data-preset="plan" title="Plan only">Plan</button>
      <button class="tool-btn" data-preset="3d" title="3D only">3D</button>
    </div>
    <div class="camera-toggle" id="camera3d-toggle" title="3D camera angle">
      <button class="tool-btn active" data-camera3d="observer" title="Perspective 3D view">Persp</button>
      <button class="tool-btn" data-camera3d="top" title="Top-down 3D view">Top</button>
    </div>
    <button class="tool-btn" id="dark-toggle" title="Toggle dark mode">◐</button>
  `

  for (const btn of toolbar.querySelectorAll<HTMLButtonElement>('button[data-tool]')) {
    btn.addEventListener('click', () => {
      try { engine.setTool(btn.dataset.tool as PlanTool) } catch { /* ignore */ }
      catalogPanel?.disarm()
      refreshToolbar()
      refreshStatus()
    })
  }

  toolbar.querySelector('#btn-undo')!.addEventListener('click', () => { store.undo(); refreshAll() })
  toolbar.querySelector('#btn-redo')!.addEventListener('click', () => { store.redo(); refreshAll() })

  toolbar.querySelector('#magnetism')!.addEventListener('change', (e) => {
    engine.setMagnetism((e.target as HTMLInputElement).checked)
  })

  toolbar.querySelector('#btn-fit')!.addEventListener('click', () => {
    doFit()
  })

  for (const btn of toolbar.querySelectorAll<HTMLButtonElement>('button[data-preset]')) {
    btn.addEventListener('click', () => setCameraPreset(btn.dataset.preset as string))
  }

  for (const btn of toolbar.querySelectorAll<HTMLButtonElement>('button[data-camera3d]')) {
    btn.addEventListener('click', () => {
      view3d?.setActivePreset(btn.dataset.camera3d as CameraPresetName)
      refreshCamera3DButtons()
    })
  }

  toolbar.querySelector('#dark-toggle')!.addEventListener('click', toggleDarkMode)

  toolbar.querySelector('#btn-catalog')!.addEventListener('click', () => {
    catalogHost.classList.toggle('collapsed')
    resizeCanvas()
    refreshStatus()
  })
}

function refreshToolbar(): void {
  const tool = engine.getTool()
  for (const btn of toolbar.querySelectorAll<HTMLButtonElement>('button[data-tool]')) {
    btn.classList.toggle('active', btn.dataset.tool === tool)
  }
  const magBox = toolbar.querySelector<HTMLInputElement>('#magnetism')
  if (magBox) magBox.checked = engine.isMagnetismEnabled()

  const undoBtn = toolbar.querySelector<HTMLButtonElement>('#btn-undo')!
  const redoBtn = toolbar.querySelector<HTMLButtonElement>('#btn-redo')!
  undoBtn.disabled = !hasUndo()
  redoBtn.disabled = !hasRedo()
  refreshCamera3DButtons()
}

function refreshCamera3DButtons(): void {
  // At boot the 3D view isn't constructed yet; the HTML default (observer
  // marked active) already matches the initial preset, so leave it alone.
  if (!view3d) return
  const active = view3d.director.getActivePreset()
  for (const btn of toolbar.querySelectorAll<HTMLButtonElement>('button[data-camera3d]')) {
    btn.classList.toggle('active', btn.dataset.camera3d === active)
  }
}

function refreshLevelButtons(): void {
  const home = store.getHome()
  const group = toolbar.querySelector<HTMLDivElement>('#level-group')!
  const canDelete = home.levels.length > 1
  let html = `<button class="tool-btn" id="btn-level-all" title="Show all levels" data-level="all">All</button>`
  for (const level of home.levels) {
    const isActive = activeLevelId === level.id
    html += `<button class="tool-btn level-btn${isActive ? ' active' : ''}" data-level="${level.id}" title="${level.name}">${level.name}</button>`
    html += `<button class="level-delete" data-delete-level="${level.id}" title="Delete level"${canDelete ? '' : ' disabled'}>×</button>`
  }
  html += `<button class="tool-btn" id="btn-add-level" title="Add level">+</button>`
  group.innerHTML = html

  group.querySelector('#btn-level-all')!.addEventListener('click', () => {
    activeLevelId = null
    engine.setActiveLevel(null)
    refreshAll()
  })

  for (const btn of group.querySelectorAll<HTMLButtonElement>('button.level-btn')) {
    btn.addEventListener('click', () => {
      activeLevelId = btn.dataset.level!
      engine.setActiveLevel(activeLevelId)
      refreshAll()
    })
    btn.addEventListener('dblclick', () => {
      const level = home.levels.find((l) => l.id === btn.dataset.level)
      if (!level) return
      const newName = window.prompt('Rename level:', level.name)
      if (newName && newName.trim()) {
        model.updateLevel(level.id, { name: newName.trim() })
        refreshAll()
      }
    })
  }

  for (const btn of group.querySelectorAll<HTMLButtonElement>('button.level-delete')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.deleteLevel!
      const level = home.levels.find((l) => l.id === id)
      if (!level) return
      if (!confirm(`Delete level "${level.name}"? This also removes everything on it. This can be undone.`)) return
      model.removeLevel(id)
      if (activeLevelId === id) {
        activeLevelId = null
        engine.setActiveLevel(null)
      }
      refreshAll()
    })
  }

  group.querySelector('#btn-add-level')!.addEventListener('click', () => {
    const name = window.prompt('Level name:', `Level ${home.levels.length + 1}`)
    if (!name || !name.trim()) return
    const elevation = home.levels.length * 250
    const created = model.addLevel({
      name: name.trim(),
      elevation,
      floorThickness: 20,
      height: 250,
      visible: true,
      viewable: true,
    })
    activeLevelId = created.id
    engine.setActiveLevel(created.id)
    refreshAll()
  })
}

// ── Status bar ──────────────────────────────────────────────────────────────

function refreshStatus(): void {
  const preview = engine.getPreview()
  const tool = engine.getTool()
  const phase = preview.phase === 'drawing' ? ' (drawing…)' : ''
  statusTool.textContent = `${tool}${phase}`
  statusAutomation.textContent = `automation: ${automationText}`
  statusZoom.textContent = `zoom: ${Math.round(currentView.scale * 100)}%`
}

// ── Camera preset ───────────────────────────────────────────────────────────

function setCameraPreset(preset: string): void {
  planPanel.classList.remove('hidden')
  view3dPanel.classList.remove('hidden')
  divider.style.display = ''

  if (preset === 'plan') {
    view3dPanel.classList.add('hidden')
    divider.style.display = 'none'
  } else if (preset === '3d') {
    planPanel.classList.add('hidden')
    divider.style.display = 'none'
  }

  for (const btn of toolbar.querySelectorAll<HTMLButtonElement>('button[data-preset]')) {
    btn.classList.toggle('active', btn.dataset.preset === preset)
  }

  resizeCanvas()
}

// ── Dark mode ───────────────────────────────────────────────────────────────

const DARK_KEY = 'homely-dark-mode'

function applyDarkMode(): void {
  const stored = localStorage.getItem(DARK_KEY)
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const dark = stored !== null ? stored === 'true' : prefersDark
  document.body.classList.toggle('dark', dark)
}

function toggleDarkMode(): void {
  const current = document.body.classList.contains('dark')
  const next = !current
  localStorage.setItem(DARK_KEY, String(next))
  document.body.classList.toggle('dark', next)
}

applyDarkMode()

// ── Draggable divider ───────────────────────────────────────────────────────

let dragging = false

divider.addEventListener('pointerdown', (e) => {
  dragging = true
  divider.classList.add('dragging')
  divider.setPointerCapture(e.pointerId)
  e.preventDefault()
})

divider.addEventListener('pointermove', (e) => {
  if (!dragging) return
  const mainRect = root.querySelector('#main-area')!.getBoundingClientRect()
  const isVertical = window.innerWidth >= 800

  if (isVertical) {
    const pct = ((e.clientX - mainRect.left) / mainRect.width) * 100
    const clamped = Math.max(15, Math.min(85, pct))
    planPanel.style.flex = `0 0 ${clamped}%`
    view3dPanel.style.flex = `0 0 ${100 - clamped}%`
  } else {
    const pct = ((e.clientY - mainRect.top) / mainRect.height) * 100
    const clamped = Math.max(15, Math.min(85, pct))
    planPanel.style.flex = `0 0 ${clamped}%`
    view3dPanel.style.flex = `0 0 ${100 - clamped}%`
  }
  resizeCanvas()
})

divider.addEventListener('pointerup', () => {
  dragging = false
  divider.classList.remove('dragging')
})

// ── Canvas input (screen px -> model cm) ────────────────────────────────────

interface PointerState {
  down: boolean
  startX: number
  startY: number
  lastX: number
  lastY: number
  moved: boolean
  shift: boolean
  button: number
}

const pointer: PointerState = {
  down: false,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastY: 0,
  moved: false,
  shift: false,
  button: 0,
}

function eventModelPoint(event: PointerEvent | MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / rect.width
  const scaleY = canvas.height / rect.height
  const px = (event.clientX - rect.left) * scaleX
  const py = (event.clientY - rect.top) * scaleY
  return new ViewMapper(currentView).toModel(px, py)
}

function canvasPixelCoords(event: PointerEvent | MouseEvent): { px: number; py: number } {
  const rect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / rect.width
  const scaleY = canvas.height / rect.height
  return {
    px: (event.clientX - rect.left) * scaleX,
    py: (event.clientY - rect.top) * scaleY,
  }
}

// Middle-click pan
canvas.addEventListener('pointerdown', (event) => {
  if (event.button === 1) {
    isPanning = true
    userHasZoomed = true
    panLastX = event.clientX
    panLastY = event.clientY
    canvas.setPointerCapture(event.pointerId)
    event.preventDefault()
    return
  }

  // Space + left-click: start pan
  if (event.button === 0 && spaceHeld) {
    isPanning = true
    userHasZoomed = true
    panLastX = event.clientX
    panLastY = event.clientY
    canvas.setPointerCapture(event.pointerId)
    return
  }

  if (event.button !== 0) return
  canvas.setPointerCapture(event.pointerId)
  const point = eventModelPoint(event)
  pointer.down = true
  pointer.moved = false
  pointer.shift = event.shiftKey
  pointer.button = event.button
  pointer.startX = point.x
  pointer.startY = point.y
  pointer.lastX = point.x
  pointer.lastY = point.y
})

canvas.addEventListener('pointermove', (event) => {
  const coords = canvasPixelCoords(event)
  const pt = new ViewMapper(currentView).toModel(coords.px, coords.py)
  statusCursor.textContent = `x: ${pt.x.toFixed(1)}  y: ${pt.y.toFixed(1)}`

  // Cursor management for selection tool
  if (engine.getTool() === 'selection' && !isPanning && !pointer.down) {
    const hit = engine.hitTestPoint(pt)
    if (!hit) {
      canvas.style.cursor = 'default'
    } else if (hit.kind === 'wall-endpoint') {
      canvas.style.cursor = 'crosshair'
    } else if (hit.kind === 'wall-body') {
      canvas.style.cursor = 'move'
    } else {
      canvas.style.cursor = 'pointer'
    }
  } else if (engine.isVertexDragging()) {
    canvas.style.cursor = 'crosshair'
  }

  if (isPanning) {
    const dx = event.clientX - panLastX
    const dy = event.clientY - panLastY
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    currentView.offsetX += dx * scaleX
    currentView.offsetY += dy * scaleY
    panLastX = event.clientX
    panLastY = event.clientY
    return
  }

  if (!pointer.down) return
  const point = eventModelPoint(event)
  const dxPx = Math.abs(point.x - pointer.startX)
  const dyPx = Math.abs(point.y - pointer.startY)
  if (dxPx > 2 || dyPx > 2) pointer.moved = true
  pointer.lastX = point.x
  pointer.lastY = point.y
})

canvas.addEventListener('pointerup', (event) => {
  if (isPanning) {
    isPanning = false
    return
  }
  if (!pointer.down) return
  pointer.down = false
  const point = eventModelPoint(event)

  // Catalog place mode: a plain click commits the armed piece at the point,
  // snapped to the nearest wall when magnetism is on.
  if (!pointer.moved && catalogPanel?.isArmed()) {
    const item = catalogPanel.armedItem
    const snap = item
      ? snapFurniturePlacement({
          walls: store.getHome().walls,
          point,
          depthCm: item.depth,
          magnetismEnabled: engine.isMagnetismEnabled(),
        })
      : { x: point.x, y: point.y, angleDeg: 0 }
    catalogPanel.place(snap.x, snap.y, snap.angleDeg)
    refreshToolbar()
    refreshStatus()
    return
  }

  if (pointer.moved) {
    engine.drag({
      fromX: pointer.startX,
      fromY: pointer.startY,
      toX: point.x,
      toY: point.y,
      shift: pointer.shift,
      altOrMeta: event.altKey || event.metaKey,
    })
  } else {
    engine.click({
      x: point.x,
      y: point.y,
      dbl: false,
      shift: event.shiftKey,
      altOrMeta: event.altKey || event.metaKey,
    })
  }
  refreshToolbar()
  refreshStatus()
})

canvas.addEventListener('dblclick', (event) => {
  if (event.button === 1) {
    doFit()
    return
  }
  const point = eventModelPoint(event)
  engine.click({ x: point.x, y: point.y, dbl: true, shift: event.shiftKey })
  refreshToolbar()
  refreshStatus()
})

// Scroll wheel zoom centered on cursor
canvas.addEventListener('wheel', (event) => {
  event.preventDefault()
  userHasZoomed = true
  const { px, py } = canvasPixelCoords(event)
  const modelBefore = new ViewMapper(currentView).toModel(px, py)

  const factor = event.deltaY > 0 ? 0.9 : 1.1
  const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, currentView.scale * factor))
  currentView.scale = newScale

  // Adjust offset so the model point under the cursor stays fixed.
  currentView.offsetX = px - modelBefore.x * currentView.scale
  currentView.offsetY = py - modelBefore.y * currentView.scale

  refreshStatus()
}, { passive: false })

window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'z') {
    event.preventDefault()
    store.undo()
    refreshAll()
    return
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || (event.shiftKey && event.key === 'z'))) {
    event.preventDefault()
    store.redo()
    refreshAll()
    return
  }

  if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
    event.preventDefault()
    selectAll()
    return
  }

  // Clipboard shortcuts — skip Ctrl+C/V when focused in a text input so
  // native browser copy/paste takes precedence.
  const isInput = event.target instanceof HTMLElement &&
    (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.isContentEditable)
  if ((event.ctrlKey || event.metaKey) && event.key === 'c' && !isInput) {
    event.preventDefault()
    if (clipboardManager.copy() > 0) refreshAll()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'v' && !isInput) {
    event.preventDefault()
    if (clipboardManager.paste().length > 0) refreshAll()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'd') {
    event.preventDefault()
    if (clipboardManager.duplicate().length > 0) refreshAll()
    return
  }

  if (event.key === ' ' && !event.repeat) {
    event.preventDefault()
    spaceHeld = true
    canvas.style.cursor = 'grab'
    return
  }

  if (event.key === 'f' || event.key === 'F') {
    event.preventDefault()
    catalogHost.classList.toggle('collapsed')
    resizeCanvas()
    refreshStatus()
    return
  }

  // Catalog place mode: Escape disarms instead of switching tools.
  if (event.key === 'Escape' && catalogPanel?.isArmed()) {
    event.preventDefault()
    catalogPanel.disarm()
    refreshStatus()
    return
  }

  let key: 'escape' | 'delete' | 'backspace' | null = null
  if (event.key === 'Escape') key = 'escape'
  else if (event.key === 'Delete') key = 'delete'
  else if (event.key === 'Backspace') key = 'backspace'
  else if (event.key === ']') { propsPanel.toggle(); return }
  if (key === null) return
  event.preventDefault()
  engine.key(key)
  refreshToolbar()
  refreshStatus()
})

window.addEventListener('keyup', (event) => {
  if (event.key === ' ') {
    spaceHeld = false
    canvas.style.cursor = ''
  }
})

// ── Render loop ─────────────────────────────────────────────────────────────

function render(): void {
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const home = store.getHome()
  const preview: PlanPreview | null = engine.getPreview()
  const rc = ctx as unknown as PlanRenderingContext
  drawPlan(home, preview, rc, currentView, canvas.width, canvas.height, activeLevelId)
}

let userHasZoomed = false

function frame(): void {
  render()
  requestAnimationFrame(frame)
}

function doFit(): void {
  userHasZoomed = false
  currentView = fitToBounds(store.getHome(), canvas.width, canvas.height, 40, activeLevelId)
  if (view3d) {
    view3d.setActivePreset(view3d.director.getActivePreset())
  }
  refreshStatus()
}

function selectAll(): void {
  const home = store.getHome()
  const matchLevel = (levelRef: string | null | undefined): boolean => {
    if (activeLevelId === null) return true
    return (levelRef ?? null) === activeLevelId
  }
  const ids = [
    ...home.levels,
    ...home.walls.filter((w) => matchLevel(w.levelRef)),
    ...home.rooms.filter((r) => matchLevel(r.levelRef)),
    ...home.furniture.filter((f) => matchLevel(f.levelRef)),
    ...home.dimensionLines.filter((d) => matchLevel(d.levelRef)),
    ...home.labels.filter((l) => matchLevel(l.levelRef)),
  ].map((i) => i.id)
  model.setSelection(ids)
  refreshAll()
}

function resizeCanvas(): void {
  const w = planPanel.clientWidth
  const h = planPanel.clientHeight
  canvas.width = Math.max(320, Math.floor(w))
  canvas.height = Math.max(200, Math.floor(h))
  if (!userHasZoomed) {
    currentView = fitToBounds(store.getHome(), canvas.width, canvas.height, 40, activeLevelId)
  }
}

function refreshAll(): void {
  refreshMenus()
  refreshToolbar()
  refreshLevelButtons()
  refreshStatus()
}

// ── Boot ────────────────────────────────────────────────────────────────────

refreshMenus()
buildToolbar()
resizeCanvas()
refreshToolbar()
refreshLevelButtons()
refreshStatus()
window.addEventListener('resize', resizeCanvas)
requestAnimationFrame(frame)

// Warn before closing with unsaved changes.
window.addEventListener('beforeunload', (e) => {
  if (store.isDirty()) {
    e.preventDefault()
  }
})

// 3D view — creates its own renderer inside #view3d
view3d = new View3D(store, {
  container: root.querySelector<HTMLDivElement>('#view3d')!,
  modelUrlResolver,
  // Placement in the 3D view: when a catalog piece is armed, a click on the
  // floor places it (snapped to walls), mirroring the 2D plan flow.
  isPlacing: () => catalogPanel?.isArmed() ?? false,
  onFloorClick: (p) => {
    if (!catalogPanel?.isArmed()) return
    const item = catalogPanel.armedItem!
    const snap = snapFurniturePlacement({
      walls: store.getHome().walls,
      point: p,
      depthCm: item.depth,
      magnetismEnabled: engine.isMagnetismEnabled(),
    })
    catalogPanel.place(snap.x, snap.y, snap.angleDeg)
    refreshToolbar()
    refreshStatus()
  },
})
// Expose for E2E testing
;(window as unknown as { __view3d: View3D }).__view3d = view3d
;(window as unknown as { __model: HomeModel }).__model = model

// Properties panel — right sidebar
const mainArea = root.querySelector<HTMLDivElement>('#main-area')!
const propsPanel = new PropertiesPanel(store, mainArea)

// Furniture catalog panel — left sidebar (ticket U7). Loaded async from the
// bundled manifest; until it resolves, place mode is unavailable. connectAutomation
// awaits this so the shared catalog reaches the automation handler too.
let sharedCatalog: FurnitureCatalog | null = null
let userCatalog: import('./core/user-catalog').UserCatalog | null = null

const catalogReady = loadDefaultCatalog().then(async ({ catalog }) => {
  const { UserCatalog, InMemoryModelStore } = await import('./core/user-catalog')
  sharedCatalog = catalog
  // Merge user-imported items on top of the bundled defaults. The store is
  // in-memory for now; swap in IndexedDB/Tauri-fs in the persistence ticket.
  userCatalog = new UserCatalog(catalog, new InMemoryModelStore())
  await userCatalog.refresh()
  sharedCatalog = userCatalog.merged

  catalogPanel = new CatalogPanel({
    catalog: sharedCatalog,
    onPlace: (item, x, y, angleDeg) => {
      model.getStore().beginCompoundEdit()
      const placed = model.addFurniture({
        name: item.name,
        catalogId: item.catalogId,
        x,
        y,
        angleDeg,
        width: item.width,
        depth: item.depth,
        height: item.height,
        elevation: item.elevation ?? 0,
        color: item.color ?? null,
        doorOrWindow: item.doorOrWindow ?? false,
        modelPath: item.modelPath ?? null,
        levelRef: activeLevelId,
      })
      model.setSelection([placed.id])
      model.getStore().endCompoundEdit()
      refreshToolbar()
      refreshStatus()
      return placed.id
    },
    onPlaceModeChange: (active) => {
      canvas.style.cursor = active ? 'crosshair' : ''
      const v3 = document.querySelector<HTMLCanvasElement>('#view3d canvas')
      if (v3) v3.style.cursor = active ? 'crosshair' : ''
    },
    onImportModel: () => {
      importModelFile()
    },
  })
  catalogHost.appendChild(catalogPanel.element)
}).catch((err) => {
  console.error('[catalog] failed to load catalog:', err)
  automationText = 'catalog unavailable'
  refreshStatus()
})

// ── User model import (runtime) ─────────────────────────────────────────────

let fileInput: HTMLInputElement | null = null

/**
 * Open a .glb file picker and import the model into the user catalog. The
 * model joins the merged catalog immediately; its blob URL feeds View3D.
 */
function importModelFile(): void {
  if (!fileInput) {
    fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.accept = '.glb,model/gltf-binary,model/gltf+json'
    fileInput.addEventListener('change', () => {
      const file = fileInput?.files?.[0]
      if (!file) return
      void (async () => {
        try {
          // Fail fast on obviously bad files before buffering anything.
          const { MAX_IMPORT_BYTES, validateGlbData } = await import('./core/user-catalog')
          if (file.size > MAX_IMPORT_BYTES) {
            throw new Error(
              `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — the import limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB`,
            )
          }
          const data = await file.arrayBuffer()
          validateGlbData(data, file.name)
          if (!userCatalog) throw new Error('catalog not ready')
          // Scene rendering swallows model-load errors (gray box), so the
          // bytes must parse cleanly before they join the catalog.
          try {
            const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
            await new GLTFLoader().parseAsync(data, '')
          } catch {
            throw new Error(
              `${file.name} could not be parsed as a GLB model — the file may be corrupted or truncated`,
            )
          }
          const record = await userCatalog.import({
            fileName: file.name,
            data,
          })
          // Keep a blob URL so View3D can load the model bytes.
          const blob = new Blob([data], { type: 'model/gltf-binary' })
          const url = URL.createObjectURL(blob)
          userModelUrls.set(record.blobKey, url)
          // Refresh the merged catalog + panel + automation surface.
          sharedCatalog = userCatalog.merged
          catalogPanel?.setCatalog(sharedCatalog)
          catalogPanel?.disarm()
          refreshToolbar()
          refreshStatus()
          statusAutomation.textContent = `imported ${record.name}`
        } catch (err) {
          console.error('[catalog] import failed:', err)
          const reason = err instanceof Error ? err.message : String(err)
          catalogPanel?.renderStatusMessage(`Import failed: ${reason}`)
          statusAutomation.textContent = 'import failed'
        }
      })()
    })
  }
  fileInput.value = ''
  fileInput.click()
}

// ── Automation ──────────────────────────────────────────────────────────────

async function connectAutomation(): Promise<void> {
  const queryPort = automationPortFromSearch(window.location.search)
  let port = queryPort
  if (port === null && '__TAURI_INTERNALS__' in window) {
    const { invoke } = await import('@tauri-apps/api/core')
    const raw = await invoke<string | null>('automation_port')
    port = raw === null ? null : Number(raw)
  }
  if (port !== null) {
    try {
      await catalogReady // ensure the shared catalog reaches the handler
    } catch {
      // catalog load failed; proceed without catalog support
    }
    new AutomationClient(new HomelyCommandHandler(store, { planEngine: engine, catalog: sharedCatalog, clipboardManager }), {
      port,
      mode: 'gui',
      onStatus: (status: ClientStatus) => {
        automationText = status
        refreshStatus()
      },
    })
  } else {
    automationText = 'idle (launch with ?automationPort=<port>)'
    refreshStatus()
  }
}
void connectAutomation()

export { catalogReady }
