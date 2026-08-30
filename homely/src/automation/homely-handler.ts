import type { HomeStore } from '../core/store'
import { serializeHome } from '../core/export'
import { HomeModel, ModelError, assert, DEFAULT_LEVEL_HEIGHT_CM } from '../core/model'
import type {
  NormalizedHomeState,
  Wall,
  Room,
  Furniture,
  DimensionLine,
  Label,
  Level,
} from '../core/home'
import { isNormalizedHome, saveProject, loadProject } from '../core/project-store'
import type { CameraPatch } from '../view3d/cameras'
import { CameraDirector } from '../view3d/cameras'
import { PlanEngine, type ClickInput, type DragInput, type PlanKey, type PlanTool } from '../plan/engine'
import { ClipboardManager, type CollectionName } from '../plan/clipboard'
import { CaptureService, type CaptureBackend } from './capture'
import type { CommandHandler, CommandResult } from './client'
import { FurnitureCatalog } from '../core/catalog'
import { resolvePlacement, toWireItem } from '../core/catalog-service'

const COMMANDS = [
  'ping',
  'new_home',
  'open',
  'save',
  'get_state',
  'get_capabilities',
  'add_furniture',
  'catalog_add_furniture',
  'list_catalog',
  'undo',
  'redo',
  'set_camera',
  'camera_preset',
  'select_tool',
  'move_mouse',
  'click',
  'drag',
  'key',
  'set_magnetism',
  'select_object',
  'select_all',
  'clear_selection',
  'delete_selection',
  'copy',
  'paste',
  'duplicate',
  'modify_selected',
  'add_room',
  'add_level',
  'remove_level',
  'add_dimension_line',
  'add_label',
  'zoom',
  'set_view',
  'screenshot',
  'add_door',
  'add_window',
] as const

const CAMERA_FIELDS = ['x', 'y', 'z', 'yawDeg', 'pitchDeg', 'fovDeg'] as const

function requireNumber(params: Record<string, unknown>, field: string): number {
  const value = params[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ModelError(`param ${field} must be a finite number`)
  }
  return value
}

/** Answers the Wave-1 command subset of docs/specs/ws-protocol.md v1. */
export class HomelyCommandHandler implements CommandHandler {
  readonly commands = COMMANDS

  private readonly store: HomeStore
  private readonly model: HomeModel
  private readonly cameras: CameraDirector
  private readonly plan: PlanEngine
  private readonly capture: CaptureService
  private readonly catalog: FurnitureCatalog | null
  private readonly clipboardManager: ClipboardManager
  private activeView: 'plan' | '3d' = '3d'

  constructor(
    store: HomeStore,
    options?: {
      planEngine?: PlanEngine
      captureBackend?: CaptureBackend
      /** Injectable catalog; omit for inline-only add_furniture (back-compat). */
      catalog?: FurnitureCatalog | null
      clipboardManager?: ClipboardManager
    },
  ) {
    this.store = store
    const model = new HomeModel(store)
    this.model = model
    this.cameras = new CameraDirector(store, model)
    this.plan = options?.planEngine ?? new PlanEngine(model)
    this.capture = new CaptureService(store, this.cameras, options?.captureBackend)
    this.catalog = options?.catalog ?? null
    this.clipboardManager = options?.clipboardManager ?? new ClipboardManager(store, model)
  }

  execute(type: string, params: Record<string, unknown>): CommandResult {
    try {
      return this.dispatch(type, params)
    } catch (err) {
      if (err instanceof ModelError) {
        return { ok: false, error: err.message, code: 'INVALID_PARAMS' }
      }
      throw err
    }
  }

  private dispatch(type: string, params: Record<string, unknown>): CommandResult {
    switch (type) {
      case 'ping':
        return { ok: true, data: { pong: true } }
      case 'new_home':
        this.store.resetToEmpty()
        return { ok: true, data: {} }
      case 'get_state':
        return { ok: true, data: serializeHome(this.store.getHome()) }
      case 'get_capabilities':
        return { ok: true, data: { commands: [...this.commands] } }
      case 'add_furniture': {
        // Frozen protocol shape is {catalogId,x,y,angleDeg?}; dimensions may be
        // resolved from the loaded catalog (when present) OR supplied inline
        // (back-compat with the pre-catalog deviation, documented in
        // docs/behaviours/sh3d-plan-tool-behaviours.md).
        const catalogId = params.catalogId ?? null
        assert(catalogId === null || typeof catalogId === 'string', 'param catalogId must be a string')

        let name: string
        let width: number
        let depth: number
        let height: number
        let elevation = params.elevation === undefined ? 0 : requireNumber(params, 'elevation')
        let color: number | null = null
        let doorOrWindow = false
        let modelPath: string | null = null

        if (catalogId !== null && this.catalog) {
          const resolved = resolvePlacement(this.catalog, catalogId)
          name = resolved.name
          width = resolved.width
          depth = resolved.depth
          height = resolved.height
          if (params.elevation === undefined) elevation = resolved.elevation!
          color = resolved.color ?? null
          doorOrWindow = resolved.doorOrWindow ?? false
          modelPath = resolved.modelPath ?? null
        } else {
          const nameParam = params.name
          assert(
            typeof nameParam === 'string' && nameParam.length > 0,
            'param name must be a non-empty string',
          )
          name = nameParam
          width = requireNumber(params, 'width')
          depth = requireNumber(params, 'depth')
          height = requireNumber(params, 'height')
        }

        const furniture = this.model.addFurniture({
          name,
          catalogId,
          x: requireNumber(params, 'x'),
          y: requireNumber(params, 'y'),
          angleDeg: params.angleDeg === undefined ? 0 : requireNumber(params, 'angleDeg'),
          width,
          depth,
          height,
          elevation,
          color,
          doorOrWindow,
          modelPath,
        })
        return { ok: true, data: { id: furniture.id } }
      }
      case 'catalog_add_furniture': {
        // Catalog-driven placement: dims resolved from the manifest, not inline.
        // Wire shape mirrors ws-protocol.md:79 {catalogId,x,y,angleDeg?}.
        if (!this.catalog) {
          return {
            ok: false,
            error: 'catalog_add_furniture requires a loaded catalog',
            code: 'INVALID_REQUEST',
          }
        }
        const catalogId = params.catalogId
        assert(typeof catalogId === 'string' && catalogId.length > 0, 'param catalogId must be a non-empty string')
        const resolved = resolvePlacement(this.catalog, catalogId)
        const furniture = this.model.addFurniture({
          name: resolved.name,
          catalogId: resolved.catalogId,
          x: requireNumber(params, 'x'),
          y: requireNumber(params, 'y'),
          angleDeg: params.angleDeg === undefined ? 0 : requireNumber(params, 'angleDeg'),
          width: resolved.width,
          depth: resolved.depth,
          height: resolved.height,
          elevation: params.elevation === undefined ? resolved.elevation! : requireNumber(params, 'elevation'),
          color: resolved.color ?? null,
          doorOrWindow: resolved.doorOrWindow ?? false,
          modelPath: resolved.modelPath ?? null,
        })
        return { ok: true, data: { id: furniture.id } }
      }
      case 'list_catalog': {
        // ws-protocol.md:80 — {items:[{catalogId,name,width,depth,height,doorOrWindow}]}
        if (!this.catalog) {
          return {
            ok: false,
            error: 'list_catalog requires a loaded catalog',
            code: 'INVALID_REQUEST',
          }
        }
        return { ok: true, data: { items: this.catalog.list().map(toWireItem) } }
      }
      case 'undo': {
        this.store.undo()
        return { ok: true, data: { canUndo: this.store.canUndo(), canRedo: this.store.canRedo() } }
      }
      case 'redo': {
        this.store.redo()
        return { ok: true, data: { canUndo: this.store.canUndo(), canRedo: this.store.canRedo() } }
      }
      case 'set_camera': {
        const patch: CameraPatch = {}
        for (const field of CAMERA_FIELDS) {
          if (params[field] !== undefined) patch[field] = requireNumber(params, field)
        }
        this.cameras.setCamera(patch)
        return { ok: true, data: {} }
      }
      case 'camera_preset': {
        // Frozen shape: {preset:"top"|"observer"} -> {camera:{...}} snapshot.
        const preset = params.preset
        assert(
          preset === 'top' || preset === 'observer',
          'param preset must be "top" or "observer"',
        )
        const camera = this.cameras.usePreset(preset)
        return {
          ok: true,
          data: {
            camera: {
              x: camera.x,
              y: camera.y,
              z: camera.z,
              yawDeg: camera.yawDeg,
              pitchDeg: camera.pitchDeg,
              fovDeg: camera.fovDeg,
            },
          },
        }
      }
      case 'select_tool': {
        const tool = params.tool
        assert(typeof tool === 'string', 'param tool must be a string')
        this.plan.setTool(tool as PlanTool)
        return { ok: true, data: { tool } }
      }
      case 'click':
        this.plan.click(params as unknown as ClickInput)
        return { ok: true, data: {} }
      case 'drag':
        this.plan.drag(params as unknown as DragInput)
        return { ok: true, data: {} }
      case 'key': {
        const key = params.key
        assert(
          key === 'escape' || key === 'delete' || key === 'backspace',
          'param key must be escape|delete|backspace',
        )
        this.plan.key(key as PlanKey)
        return { ok: true, data: {} }
      }
      case 'set_magnetism': {
        this.plan.setMagnetism(params.enabled === true)
        return { ok: true, data: { magnetismEnabled: params.enabled === true } }
      }
      case 'select_object': {
        const id = params.objectId
        assert(typeof id === 'string' && id.length > 0, 'param objectId must be a non-empty string')
        this.model.setSelection([id])
        return { ok: true, data: { selection: [id] } }
      }
      case 'select_all': {
        const home = this.store.getHome()
        const ids = [
          ...home.levels,
          ...home.walls,
          ...home.rooms,
          ...home.furniture,
          ...home.dimensionLines,
          ...home.labels,
        ].map((item) => item.id)
        this.model.setSelection(ids)
        return { ok: true, data: { selection: ids } }
      }
      case 'clear_selection': {
        this.model.setSelection([])
        return { ok: true, data: { selection: [] } }
      }
      case 'delete_selection': {
        const selection = this.store.getHome().selection
        if (selection.length === 0) throw new ModelError('delete_selection requires a non-empty selection')
        this.model.removeItems(selection)
        return { ok: true, data: { removed: selection.length } }
      }
      case 'copy': {
        const count = this.clipboardManager.copy()
        if (count === 0) throw new ModelError('copy requires a non-empty selection')
        return { ok: true, data: { count } }
      }
      case 'paste': {
        const ids = this.clipboardManager.paste()
        if (ids.length === 0) throw new ModelError('clipboard is empty; copy something first')
        return { ok: true, data: { ids } }
      }
      case 'duplicate': {
        const ids = this.clipboardManager.duplicate()
        if (ids.length === 0) throw new ModelError('duplicate requires a non-empty selection')
        return { ok: true, data: { ids } }
      }
      case 'modify_selected': {
        const props = params.props
        assert(
          props !== undefined && typeof props === 'object' && !Array.isArray(props),
          'param props must be an object',
        )
        const home = this.store.getHome()
        if (home.selection.length === 0) {
          throw new ModelError('modify_selected requires a selection; use select_object first')
        }
        const updated: string[] = []
        for (const id of home.selection) {
          const collection = this.collectionOf(home, id)
          assert(collection !== null, `unknown object id: ${id}`)
          this.modifyItem(collection, id, props as Record<string, unknown>)
          updated.push(id)
        }
        return { ok: true, data: { updated } }
      }
      case 'add_room': {
        const points = params.points
        assert(
          Array.isArray(points) && points.length >= 3,
          'add_room requires points: array of [x,y] with >=3 entries',
        )
        const rest: Record<string, unknown> = {}
        for (const field of ['name', 'floorColor', 'floorVisible', 'ceilingVisible', 'areaVisible', 'levelRef']) {
          if (params[field] !== undefined) rest[field] = params[field]
        }
        const room = this.model.addRoom(
          points as Array<[number, number]>,
          rest as Partial<Omit<Room, 'id' | 'points'>>,
        )
        return { ok: true, data: { id: room.id } }
      }
      case 'add_level': {
        const level = this.model.addLevel({
          name: typeof params.name === 'string' && params.name.length > 0 ? params.name : 'Level',
          elevation: requireNumber(params, 'elevation'),
          floorThickness: requireNumber(params, 'floorThickness'),
          height: params.height === undefined ? DEFAULT_LEVEL_HEIGHT_CM : requireNumber(params, 'height'),
          visible: params.visible === undefined ? true : Boolean(params.visible),
          viewable: params.viewable === undefined ? true : Boolean(params.viewable),
        })
        return { ok: true, data: { id: level.id } }
      }
      case 'remove_level': {
        const id = params.id
        assert(typeof id === 'string' && id.length > 0, 'param id must be a non-empty string')
        this.model.removeLevel(id)
        return { ok: true, data: { removed: true } }
      }
      case 'add_dimension_line': {
        const dim = this.model.addDimensionLine({
          xStart: requireNumber(params, 'xStart'),
          yStart: requireNumber(params, 'yStart'),
          xEnd: requireNumber(params, 'xEnd'),
          yEnd: requireNumber(params, 'yEnd'),
          offset: requireNumber(params, 'offset'),
          elevationStart: params.elevationStart as number | undefined,
          elevationEnd: params.elevationEnd as number | undefined,
          levelRef: (params.levelRef as string | null) ?? null,
        })
        return { ok: true, data: { id: dim.id } }
      }
      case 'add_label': {
        const label = this.model.addLabel({
          text: params.text === undefined ? 'Label' : String(params.text),
          x: requireNumber(params, 'x'),
          y: requireNumber(params, 'y'),
          angleDeg: params.angleDeg as number | undefined,
          elevation: params.elevation as number | undefined,
          color: (params.color as number | null | undefined) ?? null,
          levelRef: (params.levelRef as string | null) ?? null,
        })
        return { ok: true, data: { id: label.id } }
      }
      case 'move_mouse': {
        this.plan.moveMouse(requireNumber(params, 'x'), requireNumber(params, 'y'))
        return { ok: true, data: {} }
      }
      case 'zoom': {
        const factor = requireNumber(params, 'factor')
        assert(factor > 0, 'zoom factor must be > 0')
        const active = this.cameras.getActivePreset()
        const cam = active === 'top' ? this.store.getHome().cameras.top : this.store.getHome().cameras.observer
        this.cameras.setCamera({ x: cam.x * factor, y: cam.y * factor, z: cam.z * factor })
        return { ok: true, data: { scale: factor } }
      }
      case 'set_view': {
        const view = params.view
        assert(view === 'plan' || view === '3d', 'param view must be "plan" or "3d"')
        this.activeView = view
        this.cameras.usePreset(view === 'plan' ? 'top' : 'observer')
        return { ok: true, data: { view } }
      }
      case 'open': {
        let loaded: NormalizedHomeState | null = null
        if (params.json !== undefined) {
          assert(isNormalizedHome(params.json), 'param json is not a valid home state')
          loaded = params.json as NormalizedHomeState
        } else if (typeof params.path === 'string' && params.path.length > 0) {
          loaded = loadProject(params.path)
          assert(loaded !== null, `no saved project at path: ${params.path}`)
        } else {
          throw new ModelError('open requires either json or path')
        }
        this.store.loadHome(loaded)
        return { ok: true, data: { name: loaded.name ?? null } }
      }
      case 'save': {
        const json = serializeHome(this.store.getHome())
        if (typeof params.path === 'string' && params.path.length > 0) {
          saveProject(params.path, json)
          return { ok: true, data: { path: params.path } }
        }
        return { ok: true, data: { json } }
      }
      case 'screenshot': {
        const view = params.view
        assert(view === 'plan' || view === '3d', 'param view must be "plan" or "3d"')
        const width = requireNumber(params, 'width')
        const height = requireNumber(params, 'height')
        return {
          ok: true,
          data: this.capture.screenshot({ view, width, height }),
        }
      }
      case 'add_door':
      case 'add_window': {
        const wallId = params.wallId
        assert(typeof wallId === 'string' && wallId.length > 0, 'param wallId must be a non-empty string')
        const home = this.store.getHome()
        const wall = home.walls.find((w) => w.id === wallId)
        if (!wall) throw new ModelError(`unknown wall id: ${wallId}`)

        const xAlongWall = params.x === undefined
          ? Math.hypot(wall.xEnd - wall.xStart, wall.yEnd - wall.yStart) / 2
          : requireNumber(params, 'x')

        let catalogId: string | null = null
        if (this.catalog) {
          const desiredWidth = params.width === undefined ? undefined : requireNumber(params, 'width')
          const doorItems = this.catalog
            .list()
            .filter((i) => i.doorOrWindow === true && (type === 'add_door' ? /door/i.test(i.name) : /window/i.test(i.name)))
          if (desiredWidth !== undefined && doorItems.length > 0) {
            const exact = doorItems.find((i) => Math.abs(i.width - desiredWidth) < 1)
            const near = doorItems.reduce((best, i) =>
              Math.abs(i.width - desiredWidth) < Math.abs(best.width - desiredWidth) ? i : best,
            )
            catalogId = exact?.catalogId ?? near.catalogId
          } else if (doorItems.length > 0) {
            catalogId = doorItems[0]!.catalogId
          }
        }

        let name: string
        let width: number
        let depth: number
        let height: number
        let elevation = 0
        let color: number | null = null
        let modelPath: string | null = null

        if (catalogId && this.catalog) {
          const resolved = resolvePlacement(this.catalog, catalogId)
          name = resolved.name
          width = resolved.width
          depth = resolved.depth
          height = resolved.height
          elevation = resolved.elevation ?? 0
          color = resolved.color ?? null
          modelPath = resolved.modelPath ?? null
        } else {
          name = type === 'add_door' ? 'Door' : 'Window'
          width = params.width === undefined ? 90 : requireNumber(params, 'width')
          depth = 10
          height = type === 'add_door' ? 210 : 120
        }

        const dx = wall.xEnd - wall.xStart
        const dy = wall.yEnd - wall.yStart
        const wallLen = Math.hypot(dx, dy) || 1
        const nx = dx / wallLen
        const ny = dy / wallLen
        const wx = -ny
        const wy = nx

        const t = Math.max(0, Math.min(wallLen, xAlongWall))
        const px = wall.xStart + nx * t + wx * (wall.thickness / 2)
        const py = wall.yStart + ny * t + wy * (wall.thickness / 2)
        const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI

        const furniture = this.model.addFurniture({
          name,
          catalogId,
          x: px,
          y: py,
          angleDeg,
          width,
          depth,
          height,
          elevation,
          color,
          doorOrWindow: true,
          modelPath,
          wallRef: wallId,
          wallOffset: t,
        })
        return { ok: true, data: { id: furniture.id } }
      }
      default:
        return { ok: false, error: `unknown command: ${type}`, code: 'UNKNOWN_COMMAND' }
    }
  }

  private collectionOf(home: NormalizedHomeState, id: string): CollectionName | null {
    for (const collection of ['levels', 'walls', 'rooms', 'furniture', 'dimensionLines', 'labels'] as CollectionName[]) {
      if (home[collection].some((item) => item.id === id)) return collection
    }
    return null
  }

  private modifyItem(collection: CollectionName, id: string, patch: Record<string, unknown>): void {
    switch (collection) {
      case 'walls':
        this.model.updateWall(id, patch as Partial<Wall>)
        break
      case 'rooms':
        this.model.updateRoom(id, patch as Partial<Room>)
        break
      case 'furniture':
        this.model.updateFurniture(id, patch as Partial<Furniture>)
        break
      case 'dimensionLines':
        this.model.updateDimensionLine(id, patch as Partial<DimensionLine>)
        break
      case 'labels':
        this.model.updateLabel(id, patch as Partial<Label>)
        break
      case 'levels':
        this.model.updateLevel(id, patch as Partial<Level>)
        break
    }
  }

}
