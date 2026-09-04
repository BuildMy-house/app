import type {
  ActiveTool,
  CompassState,
  DimensionLine,
  EnvironmentState,
  Furniture,
  Label,
  Level,
  NormalizedHomeState,
  Roof,
  Room,
  Wall,
} from './home'
import { DEFAULT_WALL_HEIGHT_CM, WALL_TEXTURES } from './home'
import type { HomeStore } from './store'
import { normalizeAngle } from './export'

export const DEFAULT_LEVEL_HEIGHT_CM = DEFAULT_WALL_HEIGHT_CM

/** Driver forces prefs newWallThickness=7f at boot (SH3D stock default is 7.5). */
export const NEW_WALL_THICKNESS_CM = 7

/** Home.NEW_WALL_PATTERN default: walls created by the wall tool get hatchUp. */
export const NEW_WALL_PATTERN_ID = 'hatchUp'

/** Thrown by HomeModel ops on invalid input; surfaces as INVALID_PARAMS over automation. */
export class ModelError extends Error {}

type IdLike = { id: string }
type CollectionKey = 'levels' | 'walls' | 'rooms' | 'furniture' | 'dimensionLines' | 'labels' | 'roofs'

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ModelError(message)
}

function requirePositive(value: unknown, field: string): void {
  assert(
    typeof value === 'number' && Number.isFinite(value) && value > 0,
    `${field} must be a finite number > 0`,
  )
}

function requireFinite(value: unknown, field: string): void {
  assert(typeof value === 'number' && Number.isFinite(value), `${field} must be a finite number`)
}

function requireMinimum(value: unknown, field: string, min: number): void {
  assert(
    typeof value === 'number' && Number.isFinite(value) && value >= min,
    `${field} must be a finite number >= ${min}`,
  )
}

/** Re-validates patches so updates can never smuggle schema-invalid state in. */
function validatePatch(key: CollectionKey, patch: Record<string, unknown>): void {
  switch (key) {
    case 'walls': {
      for (const field of ['xStart', 'yStart', 'xEnd', 'yEnd', 'heightAtEnd', 'arcExtent']) {
        if (patch[field] !== undefined) requireFinite(patch[field], field)
      }
      if (patch.height !== undefined) requireMinimum(patch.height, 'height', 1)
      if (patch.thickness !== undefined) requireMinimum(patch.thickness, 'thickness', 0.1)
      const validTextureIds = new Set(WALL_TEXTURES.map((t) => t.id))
      for (const field of ['leftSideTextureId', 'rightSideTextureId']) {
        if (patch[field] !== undefined && patch[field] !== null) {
          assert(
            typeof patch[field] === 'string' && validTextureIds.has(patch[field]),
            `${field} must be a known texture id or null`,
          )
        }
      }
      break
    }
    case 'rooms': {
      if (patch.points !== undefined) {
        const points = patch.points
        assert(
          Array.isArray(points) && points.length >= 3,
          `room needs at least 3 points, got ${Array.isArray(points) ? points.length : typeof points}`,
        )
        for (const point of points) {
          assert(Array.isArray(point) && point.length === 2, 'room point must be [x, y]')
          requireFinite(point[0], 'point x')
          requireFinite(point[1], 'point y')
        }
      }
      break
    }
    case 'furniture': {
      for (const field of ['x', 'y', 'elevation', 'pitchDeg', 'rollDeg']) {
        if (patch[field] !== undefined) requireFinite(patch[field], field)
      }
      if (patch.angleDeg !== undefined) {
        requireFinite(patch.angleDeg, 'angleDeg')
        patch.angleDeg = normalizeAngle(patch.angleDeg as number)
      }
      for (const field of ['width', 'depth', 'height']) {
        if (patch[field] !== undefined) requireMinimum(patch[field], field, 0.1)
      }
      if (patch.modelRotationDeg !== undefined) {
        assert(Array.isArray(patch.modelRotationDeg), 'modelRotationDeg must be an array')
        for (const entry of patch.modelRotationDeg) requireFinite(entry, 'modelRotationDeg entry')
      }
      break
    }
    case 'dimensionLines': {
      for (const field of ['xStart', 'yStart', 'xEnd', 'yEnd', 'offset', 'elevationStart', 'elevationEnd']) {
        if (patch[field] !== undefined) requireFinite(patch[field], field)
      }
      break
    }
    case 'labels': {
      for (const field of ['x', 'y', 'angleDeg', 'elevation']) {
        if (patch[field] !== undefined) requireFinite(patch[field], field)
      }
      if (patch.text !== undefined) assert(typeof patch.text === 'string', 'label text must be a string')
      break
    }
    case 'levels': {
      for (const field of ['elevation', 'floorThickness']) {
        if (patch[field] !== undefined) requireFinite(patch[field], field)
      }
      if (patch.height !== undefined) requirePositive(patch.height, 'height')
      if (patch.name !== undefined) {
        assert(typeof patch.name === 'string' && patch.name.length > 0, 'level name required')
      }
      break
    }
    case 'roofs': {
      if (patch.points !== undefined) {
        const points = patch.points
        assert(
          Array.isArray(points) && points.length >= 3,
          `roof needs at least 3 points, got ${Array.isArray(points) ? points.length : typeof points}`,
        )
        for (const point of points) {
          assert(Array.isArray(point) && point.length === 2, 'roof point must be [x, y]')
          requireFinite(point[0], 'point x')
          requireFinite(point[1], 'point y')
        }
      }
      break
    }
  }
}

/**
 * Typed domain operations over a HomeStore. Every op is one undo step.
 * Optional fields are materialized with schema defaults so exports stay
 * stable regardless of how an object was created.
 */
export class HomeModel {
  constructor(private readonly store: HomeStore) {}

  getStore(): HomeStore {
    return this.store
  }

  setName(name: string): void {
    this.store.apply((h) => {
      h.name = name
    })
  }

  addLevel(input: Omit<Level, 'id'>): Level {
    assert(typeof input.name === 'string' && input.name.length > 0, 'level name required')
    requireFinite(input.elevation, 'elevation')
    requireFinite(input.floorThickness, 'floorThickness')
    requirePositive(input.height, 'height')
    let created!: Level
    this.store.apply((h) => {
      created = { ...input, id: this.store.generateId('level') }
      h.levels.push(created)
    })
    return structuredClone(created)
  }

  removeLevel(id: string): boolean {
    const snapshot = this.store.getHome()
    assert(snapshot.levels.some((level) => level.id === id), `unknown level: ${id}`)
    const cascadeIds = new Set<string>()
    for (const key of ['walls', 'rooms', 'furniture', 'dimensionLines', 'labels', 'roofs'] as const) {
      for (const item of snapshot[key] as Array<IdLike & { levelRef?: string | null }>) {
        if (item.levelRef === id) cascadeIds.add(item.id)
      }
    }
    const allRemovable = new Set([id, ...cascadeIds])
    this.store.apply((h) => {
      h.levels = h.levels.filter((l) => l.id !== id)
      for (const key of ['walls', 'rooms', 'furniture', 'dimensionLines', 'labels', 'roofs'] as const) {
        const list = h[key] as unknown as IdLike[]
        ;(h as unknown as Record<typeof key, IdLike[]>)[key] = list.filter(
          (item) => !allRemovable.has(item.id),
        )
      }
      h.selection = h.selection.filter((sid) => !allRemovable.has(sid))
    })
    return true
  }

  updateLevel(id: string, patch: Partial<Omit<Level, 'id'>>): Level {
    return this.updateIn('levels', id, patch)
  }

  addWall(input: Omit<Wall, 'id'>): Wall {
    requireFinite(input.xStart, 'xStart')
    requireFinite(input.yStart, 'yStart')
    requireFinite(input.xEnd, 'xEnd')
    requireFinite(input.yEnd, 'yEnd')
    requireMinimum(input.thickness, 'thickness', 0.1)
    if (input.height !== undefined && input.height !== null) {
      requireMinimum(input.height, 'height', 1)
    }
    const validTextureIds = new Set(WALL_TEXTURES.map((t) => t.id))
    for (const field of ['leftSideTextureId', 'rightSideTextureId'] as const) {
      if (input[field] !== undefined && input[field] !== null) {
        assert(
          typeof input[field] === 'string' && validTextureIds.has(input[field]),
          `${field} must be a known texture id or null`,
        )
      }
    }
    let created!: Wall
    this.store.apply((h) => {
      created = { ...input, id: this.store.generateId('wall') }
      h.walls.push(created)
    })
    return structuredClone(created)
  }

  updateWall(id: string, patch: Partial<Omit<Wall, 'id'>>): Wall {
    return this.updateIn('walls', id, patch)
  }

  setWallEndpoint(wallId: string, endpoint: 'start' | 'end', x: number, y: number): void {
    requireFinite(x, 'x')
    requireFinite(y, 'y')
    this.store.apply((h) => {
      const wall = h.walls.find((w) => w.id === wallId)
      assert(wall !== undefined, `unknown wall: ${wallId}`)
      if (endpoint === 'start') {
        wall.xStart = x
        wall.yStart = y
      } else {
        wall.xEnd = x
        wall.yEnd = y
      }
    })
  }

  removeWall(id: string): boolean {
    const snapshot = this.store.getHome()
    assert(snapshot.walls.some((w) => w.id === id), `unknown wall id: ${id}`)
    this.store.apply((h) => {
      const index = h.walls.findIndex((w) => w.id === id)
      if (index >= 0) h.walls.splice(index, 1)
      const cascadeIds = new Set<string>()
      for (const f of h.furniture) {
        if (f.wallRef === id) cascadeIds.add(f.id)
      }
      if (cascadeIds.size > 0) {
        h.furniture = h.furniture.filter((f) => !cascadeIds.has(f.id))
      }
      h.selection = h.selection.filter((sid) => sid !== id && !cascadeIds.has(sid))
    })
    return true
  }

  /**
   * Commits a wall chain as ONE undoable compound operation — the clone-side
   * equivalent of SH3D PlanController.validateDrawnWalls/postCreateWalls.
   * New walls use the driver's preference defaults (thickness 7 cm, height
   * 250 cm, pattern 'hatchUp'). SH3D parity: NO room is auto-created on a
   * closed cycle; rooms come only from addRoom (the room tool).
   */
  addWallChain(
    segments: Array<{ xStart: number; yStart: number; xEnd: number; yEnd: number }>,
  ): { wallIds: string[] } {
    assert(Array.isArray(segments) && segments.length > 0, 'wall chain needs at least one segment')
    for (const segment of segments) {
      requireFinite(segment.xStart, 'xStart')
      requireFinite(segment.yStart, 'yStart')
      requireFinite(segment.xEnd, 'xEnd')
      requireFinite(segment.yEnd, 'yEnd')
      assert(
        Math.hypot(segment.xEnd - segment.xStart, segment.yEnd - segment.yStart) > 0,
        'wall chain segments must have non-zero length',
      )
    }

    const wallIds: string[] = []
    this.store.apply((h) => {
      for (const segment of segments) {
        const wall: Wall = {
          id: this.store.generateId('wall'),
          xStart: segment.xStart,
          yStart: segment.yStart,
          xEnd: segment.xEnd,
          yEnd: segment.yEnd,
          thickness: NEW_WALL_THICKNESS_CM,
          height: DEFAULT_WALL_HEIGHT_CM,
          patternId: NEW_WALL_PATTERN_ID,
        }
        h.walls.push(wall)
        wallIds.push(wall.id)
      }
      h.selection = [...wallIds]
    })
    return { wallIds: [...wallIds] }
  }

  addRoom(points: Array<[number, number]>, input: Partial<Omit<Room, 'id' | 'points'>> = {}): Room {
    assert(
      Array.isArray(points) && points.length >= 3,
      `room needs at least 3 points, got ${points?.length}`,
    )
    for (const [x, y] of points) {
      requireFinite(x, 'point x')
      requireFinite(y, 'point y')
    }
    let created!: Room
    this.store.apply((h) => {
      created = {
        id: this.store.generateId('room'),
        points: points.map(([x, y]) => [x, y] as [number, number]),
        name: input.name ?? null,
        areaVisible: input.areaVisible ?? true,
        floorVisible: input.floorVisible ?? true,
        floorColor: input.floorColor ?? null,
        ceilingVisible: input.ceilingVisible ?? false,
        levelRef: input.levelRef ?? null,
      }
      h.rooms.push(created)
    })
    return structuredClone(created)
  }

  updateRoom(id: string, patch: Partial<Omit<Room, 'id'>>): Room {
    return this.updateIn('rooms', id, patch)
  }

  removeRoom(id: string): boolean {
    return this.removeFrom('rooms', id, 'room')
  }

  addFurniture(input: Omit<Furniture, 'id'>): Furniture {
    assert(typeof input.name === 'string' && input.name.length > 0, 'furniture name required')
    requireFinite(input.x, 'x')
    requireFinite(input.y, 'y')
    requireFinite(input.angleDeg, 'angleDeg')
    requireFinite(input.elevation, 'elevation')
    requireMinimum(input.width, 'width', 0.1)
    requireMinimum(input.depth, 'depth', 0.1)
    requireMinimum(input.height, 'height', 0.1)
    const normalizedInput = { ...input, angleDeg: normalizeAngle(input.angleDeg) }
    let created!: Furniture
    this.store.apply((h) => {
      created = {
        catalogId: null,
        pitchDeg: 0,
        rollDeg: 0,
        color: null,
        visible: true,
        movable: true,
        doorOrWindow: false,
        modelRotationDeg: [],
        levelRef: null,
        ...normalizedInput,
        id: this.store.generateId('furniture'),
      }
      h.furniture.push(created)
    })
    return structuredClone(created)
  }

  updateFurniture(id: string, patch: Partial<Omit<Furniture, 'id'>>): Furniture {
    return this.updateIn('furniture', id, patch)
  }

  removeFurniture(id: string): boolean {
    return this.removeFrom('furniture', id, 'furniture')
  }

  addDimensionLine(
    input: Pick<DimensionLine, 'xStart' | 'yStart' | 'xEnd' | 'yEnd' | 'offset'> &
      Partial<Omit<DimensionLine, 'id' | 'xStart' | 'yStart' | 'xEnd' | 'yEnd' | 'offset'>>,
  ): DimensionLine {
    requireFinite(input.xStart, 'xStart')
    requireFinite(input.yStart, 'yStart')
    requireFinite(input.xEnd, 'xEnd')
    requireFinite(input.yEnd, 'yEnd')
    requireFinite(input.offset, 'offset')
    let created!: DimensionLine
    this.store.apply((h) => {
      created = {
        elevationStart: 0,
        elevationEnd: 0,
        levelRef: null,
        ...input,
        id: this.store.generateId('dimension'),
      }
      h.dimensionLines.push(created)
    })
    return structuredClone(created)
  }

  updateDimensionLine(id: string, patch: Partial<Omit<DimensionLine, 'id'>>): DimensionLine {
    return this.updateIn('dimensionLines', id, patch)
  }

  removeDimensionLine(id: string): boolean {
    return this.removeFrom('dimensionLines', id, 'dimension line')
  }

  addLabel(input: Omit<Label, 'id'>): Label {
    assert(typeof input.text === 'string', 'label text required')
    requireFinite(input.x, 'x')
    requireFinite(input.y, 'y')
    let created!: Label
    this.store.apply((h) => {
      created = { angleDeg: 0, elevation: 0, color: null, levelRef: null, ...input, id: this.store.generateId('label') }
      h.labels.push(created)
    })
    return structuredClone(created)
  }

  updateLabel(id: string, patch: Partial<Omit<Label, 'id'>>): Label {
    return this.updateIn('labels', id, patch)
  }

  removeLabel(id: string): boolean {
    return this.removeFrom('labels', id, 'label')
  }

  addRoof(points: Array<[number, number]>, input: Partial<Omit<Roof, 'id' | 'points'>> = {}): Roof {
    assert(
      Array.isArray(points) && points.length >= 3,
      `roof needs at least 3 points, got ${points?.length}`,
    )
    for (const [x, y] of points) {
      requireFinite(x, 'point x')
      requireFinite(y, 'point y')
    }
    let created!: Roof
    this.store.apply((h) => {
      created = {
        id: this.store.generateId('roof'),
        points: points.map(([x, y]) => [x, y] as [number, number]),
        name: input.name ?? null,
        color: input.color ?? null,
        levelRef: input.levelRef ?? null,
      }
      h.roofs.push(created)
    })
    return structuredClone(created)
  }

  updateRoof(id: string, patch: Partial<Omit<Roof, 'id'>>): Roof {
    return this.updateIn('roofs', id, patch)
  }

  removeRoof(id: string): boolean {
    return this.removeFrom('roofs', id, 'roof')
  }

  setSelection(ids: string[]): string[] {
    assert(Array.isArray(ids), 'selection must be an array of ids')
    const snapshot = this.store.getHome()
    // A no-op selection change must not consume an undo step.
    if (
      snapshot.selection.length === ids.length &&
      snapshot.selection.every((id, i) => id === ids[i])
    ) {
      return [...ids]
    }
    const known = new Set<string>()
    for (const key of ['levels', 'walls', 'rooms', 'furniture', 'dimensionLines', 'labels', 'roofs'] as const) {
      for (const item of snapshot[key]) known.add(item.id)
    }
    for (const id of ids) {
      assert(known.has(id), `selection references unknown id: ${id}`)
    }
    this.store.apply((h) => {
      h.selection = [...ids]
    })
    return [...ids]
  }

  setActiveTool(tool: ActiveTool): void {
    this.store.apply((h) => {
      h.activeTool = tool
    })
  }

  moveTopCamera(patch: Partial<Omit<NormalizedHomeState['cameras']['top'], 'lens'>>): void {
    requireFiniteNumbers(patch)
    this.store.apply((h) => {
      Object.assign(h.cameras.top, patch)
    })
  }

  moveObserverCamera(patch: Partial<NormalizedHomeState['cameras']['observer']>): void {
    requireFiniteNumbers(patch)
    this.store.apply((h) => {
      Object.assign(h.cameras.observer, patch)
    })
  }

  setCompass(patch: Partial<CompassState>): void {
    if (patch.diameter !== undefined) requirePositive(patch.diameter, 'diameter')
    requireFiniteNumbers(patch)
    this.store.apply((h) => {
      h.compass = { ...h.compass, ...patch }
    })
  }

  setEnvironment(patch: Partial<EnvironmentState>): void {
    if (patch.wallsAlpha !== undefined && patch.wallsAlpha !== null) {
      const alpha = patch.wallsAlpha
      assert(
        typeof alpha === 'number' && Number.isFinite(alpha) && alpha >= 0 && alpha <= 1,
        'wallsAlpha must be within [0, 1]',
      )
    }
    this.store.apply((h) => {
      h.environment = { ...h.environment, ...patch }
    })
  }

  private updateIn<K extends CollectionKey>(
    key: K,
    id: string,
    patch: Partial<NormalizedHomeState[K][number]>,
  ): NormalizedHomeState[K][number] {
    const rest: Record<string, unknown> = { ...(patch as Record<string, unknown>) }
    delete rest.id // ids are immutable; reassignment would break the ledger
    validatePatch(key, rest)
    requireFiniteNumbers(rest)
    let updated!: NormalizedHomeState[K][number]
    this.store.apply((h) => {
      const item = (h[key] as IdLike[]).find((candidate) => candidate.id === id)
      assert(item !== undefined, `unknown ${key} id: ${id}`)
      Object.assign(item, rest)
      updated = item as NormalizedHomeState[K][number]
    })
    return structuredClone(updated)
  }

  private removeFrom(key: CollectionKey, id: string, label: string): boolean {
    const snapshot = this.store.getHome()
    const exists = (snapshot[key] as IdLike[]).some((item) => item.id === id)
    assert(exists, `unknown ${label} id: ${id}`)
    this.store.apply((h) => {
      const list = h[key] as IdLike[]
      const index = list.findIndex((item) => item.id === id)
      if (index >= 0) list.splice(index, 1)
      const selection = h.selection.indexOf(id)
      if (selection >= 0) h.selection.splice(selection, 1)
    })
    return true
  }

  /** Bulk delete across all collections in ONE undo step (delete/backspace key). */
  removeItems(ids: string[]): boolean {
    assert(Array.isArray(ids) && ids.length > 0, 'removeItems needs at least one id')
    const wanted = new Set(ids)
    const snapshot = this.store.getHome()
    const found = new Set<string>()
    for (const key of ['levels', 'walls', 'rooms', 'furniture', 'dimensionLines', 'labels', 'roofs'] as const) {
      for (const item of snapshot[key] as IdLike[]) {
        if (wanted.has(item.id)) found.add(item.id)
      }
    }
    for (const id of ids) {
      assert(found.has(id), `unknown id: ${id}`)
    }
    const wallIds = new Set<string>()
    const levelIds = new Set<string>()
    for (const id of ids) {
      if (snapshot.walls.some((w) => w.id === id)) wallIds.add(id)
      if (snapshot.levels.some((l) => l.id === id)) levelIds.add(id)
    }
    const cascadeIds = new Set<string>()
    if (wallIds.size > 0) {
      for (const f of snapshot.furniture) {
        if (f.wallRef && wallIds.has(f.wallRef)) cascadeIds.add(f.id)
      }
    }
    if (levelIds.size > 0) {
      for (const key of ['walls', 'rooms', 'furniture', 'dimensionLines', 'labels', 'roofs'] as const) {
        for (const item of snapshot[key] as Array<IdLike & { levelRef?: string | null }>) {
          if (item.levelRef && levelIds.has(item.levelRef)) cascadeIds.add(item.id)
        }
      }
    }
    const allRemovable = new Set([...wanted, ...cascadeIds])
    this.store.apply((h) => {
      for (const key of ['levels', 'walls', 'rooms', 'furniture', 'dimensionLines', 'labels', 'roofs'] as const) {
        const list = h[key] as unknown as IdLike[]
        ;(h as unknown as Record<typeof key, IdLike[]>)[key] = list.filter(
          (item) => !allRemovable.has(item.id),
        )
      }
      h.selection = h.selection.filter((id) => !allRemovable.has(id))
    })
    return true
  }

  /** Translates every selected item by (dx, dy) in ONE undo step. */
  moveSelection(dx: number, dy: number): boolean {
    requireFinite(dx, 'dx')
    requireFinite(dy, 'dy')
    const selection = new Set(this.store.getHome().selection)
    if (selection.size === 0) return false
    this.store.apply((h) => {
      for (const wall of h.walls) {
        if (!selection.has(wall.id)) continue
        wall.xStart += dx
        wall.yStart += dy
        wall.xEnd += dx
        wall.yEnd += dy
      }
      for (const room of h.rooms) {
        if (!selection.has(room.id)) continue
        room.points = room.points.map(([x, y]) => [x + dx, y + dy] as [number, number])
      }
      for (const f of h.furniture) {
        if (!selection.has(f.id)) continue
        f.x += dx
        f.y += dy
      }
      for (const d of h.dimensionLines) {
        if (!selection.has(d.id)) continue
        d.xStart += dx
        d.yStart += dy
        d.xEnd += dx
        d.yEnd += dy
      }
      for (const l of h.labels) {
        if (!selection.has(l.id)) continue
        l.x += dx
        l.y += dy
      }
      for (const roof of h.roofs) {
        if (!selection.has(roof.id)) continue
        roof.points = roof.points.map(([x, y]) => [x + dx, y + dy] as [number, number])
      }
    })
    return true
  }
}

function requireFiniteNumbers(record: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number') requireFinite(value, key)
  }
}
