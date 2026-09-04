import { describe, expect, it } from 'vitest'
import { HomeModel, ModelError } from '../src/core/model'
import { HomeStore } from '../src/core/store'
import type { NormalizedHomeState } from '../src/core/home'
import {
  BrowserCaptureBackend,
  CaptureService,
  MAX_CAPTURE_DIM,
  validateScreenshotRequest,
  type CaptureBackend,
  type ScreenshotResult,
} from '../src/automation/capture'
import { CameraDirector } from '../src/view3d/cameras'
import { drawPlan, fitToBounds, type PlanRenderingContext } from '../src/plan/renderer'
import type { Scene, PerspectiveCamera } from 'three'

type Op = [string, ...unknown[]]

/** Deterministic recorder standing in for a Canvas2D context. */
class RecordingPlanContext implements PlanRenderingContext {
  readonly ops: Array<Op> = []
  lineWidth = 1
  strokeStyle = ''
  fillStyle = ''
  font = ''
  textAlign: CanvasTextAlign = 'start'
  textBaseline: CanvasTextBaseline = 'alphabetic'
  globalAlpha = 1

  private set(prop: string, value: unknown): void {
    this.ops.push(['set', prop, value])
  }

  beginPath(): void {
    this.ops.push(['beginPath'])
  }
  moveTo(x: number, y: number): void {
    this.ops.push(['moveTo', x, y])
  }
  lineTo(x: number, y: number): void {
    this.ops.push(['lineTo', x, y])
  }
  closePath(): void {
    this.ops.push(['closePath'])
  }
  stroke(): void {
    this.ops.push(['stroke'])
  }
  fill(): void {
    this.ops.push(['fill'])
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push(['fillRect', x, y, w, h])
  }
  fillText(text: string, x: number, y: number): void {
    this.ops.push(['fillText', text, x, y])
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.ops.push(['strokeRect', x, y, w, h])
  }
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void {
    this.ops.push(['arc', x, y, radius, startAngle, endAngle])
  }
  setLineDash(dashes: Array<number>): void {
    this.ops.push(['setLineDash', dashes.join(',')])
  }
  save(): void {
    this.ops.push(['save'])
  }
  restore(): void {
    this.ops.push(['restore'])
  }
  globalCompositeOperation: GlobalCompositeOperation = 'source-over'
}

interface CallRecord {
  view: string
  width: number
  height: number
  walls: number
  wallMeshes?: number
  camera?: { px: number; py: number; pz: number; rx: number; ry: number; fov: number }
}

/** Fake rasterizer: deterministic bytes derived from the exact inputs. */
class RecordingBackend implements CaptureBackend {
  readonly calls: Array<CallRecord> = []

  renderPlan(home: NormalizedHomeState, width: number, height: number): string {
    return this.record({ view: 'plan', width, height, walls: home.walls.length })
  }

  render3d(
    scene: Scene,
    camera: PerspectiveCamera,
    width: number,
    height: number,
  ): string {
    let wallMeshes = 0
    scene.traverse((object) => {
      if (String(object.name).startsWith('wall:')) wallMeshes += 1
    })
    return this.record({
      view: '3d',
      width,
      height,
      walls: -1,
      wallMeshes,
      camera: {
        px: camera.position.x,
        py: camera.position.y,
        pz: camera.position.z,
        rx: camera.rotation.x,
        ry: camera.rotation.y,
        fov: camera.fov,
      },
    })
  }

  private record(call: CallRecord): string {
    this.calls.push(call)
    return Buffer.from(JSON.stringify(call)).toString('base64')
  }
}

function makeStoreWithWalls(): HomeStore {
  const store = new HomeStore()
  store.apply((home: NormalizedHomeState) => {
    home.walls.push(
      {
        id: store.generateId('wall'),
        xStart: 0,
        yStart: 0,
        xEnd: 400,
        yEnd: 0,
        thickness: 7,
      },
      {
        id: store.generateId('wall'),
        xStart: 400,
        yStart: 0,
        xEnd: 400,
        yEnd: 300,
        thickness: 7,
      },
    )
  })
  return store
}

describe('screenshot request validation', () => {
  it('accepts plan and 3d with integer dims at boundaries', () => {
    expect(validateScreenshotRequest({ view: 'plan', width: 1, height: MAX_CAPTURE_DIM })).toEqual({
      view: 'plan',
      width: 1,
      height: MAX_CAPTURE_DIM,
    })
    expect(validateScreenshotRequest({ view: '3d', width: 640, height: 480 })).toEqual({
      view: '3d',
      width: 640,
      height: 480,
    })
  })

  it('rejects unknown views naming the offending param', () => {
    const attempt = () =>
      validateScreenshotRequest({ view: 'iso' as 'plan', width: 10, height: 10 })
    expect(attempt).toThrowError(/param view/)
  })

  it('rejects non-integer, zero, negative and oversized dims', () => {
    const bad = [
      { width: 0, height: 10 },
      { width: -5, height: 10 },
      { width: 10.5, height: 10 },
      { width: MAX_CAPTURE_DIM + 1, height: 10 },
      { width: 10, height: Number.POSITIVE_INFINITY },
    ]
    for (const dim of bad) {
      const attempt = () =>
        validateScreenshotRequest({ view: 'plan', width: dim.width, height: dim.height })
      expect(attempt).toThrowError(ModelError)
      try {
        attempt()
      } catch (err) {
        expect((err as ModelError).message).toMatch(/param (width|height)/)
      }
    }
  })
})

describe('CaptureService plan pipeline', () => {
  it('passes the current home snapshot and dims to the backend', () => {
    const store = makeStoreWithWalls()
    const backend = new RecordingBackend()
    const service = new CaptureService(store, undefined, backend)
    const result: ScreenshotResult = service.screenshot({ view: 'plan', width: 320, height: 240 })

    expect(result.pngBase64.length).toBeGreaterThan(0)
    expect(result.width).toBe(320)
    expect(result.height).toBe(240)
    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0]?.view).toBe('plan')
    expect(backend.calls[0]?.walls).toBe(2)
  })

  it('returns pixel-identical output for consecutive identical requests', () => {
    const store = makeStoreWithWalls()
    const backend = new RecordingBackend()
    const service = new CaptureService(store, undefined, backend)
    const first = service.screenshot({ view: 'plan', width: 200, height: 150 })
    const second = service.screenshot({ view: 'plan', width: 200, height: 150 })
    expect(first).toEqual(second)
  })

  it('reflects store mutations on the next capture', () => {
    const store = makeStoreWithWalls()
    const backend = new RecordingBackend()
    const service = new CaptureService(store, undefined, backend)
    service.screenshot({ view: 'plan', width: 100, height: 100 })
    store.apply((home) => {
      home.walls.push({
        id: store.generateId('wall'),
        xStart: 400,
        yStart: 300,
        xEnd: 0,
        yEnd: 300,
        thickness: 7,
      })
    })
    service.screenshot({ view: 'plan', width: 100, height: 100 })
    expect(backend.calls[0]?.walls).toBe(2)
    expect(backend.calls[1]?.walls).toBe(3)
  })
})

describe('CaptureService 3d pipeline', () => {
  it('applies the ACTIVE automation camera before rendering', () => {
    const store = makeStoreWithWalls()
    const cameras = new CameraDirector(store, new HomeModel(store))
    const backend = new RecordingBackend()
    const service = new CaptureService(store, cameras, backend)

    cameras.setCamera({ yawDeg: 123 })
    service.screenshot({ view: '3d', width: 800, height: 600 })
    const first = backend.calls[0]
    expect(first?.camera?.py).toBeCloseTo(170)
    expect(first?.camera?.ry).not.toBeUndefined()
    expect(first?.wallMeshes).toBe(2)

    cameras.usePreset('top')
    service.screenshot({ view: '3d', width: 800, height: 600 })
    const second = backend.calls[1]
    // Top camera follows contents (B7): L-shaped walls give bounds center
    // (201.75,148.25,125) with the fresh-home distance 1414.21 preserved.
    expect(second?.camera?.py).toBeCloseTo(1125)
    expect(second?.camera?.pz).toBeCloseTo(1148.25)
    expect(second?.camera?.px).toBeCloseTo(201.75)
    expect(second?.camera?.fov).toBe(63)
  })

  it('keeps consecutive identical renders byte-equal', () => {
    const store = makeStoreWithWalls()
    const cameras = new CameraDirector(store, new HomeModel(store))
    const backend = new RecordingBackend()
    const service = new CaptureService(store, cameras, backend)
    const first = service.screenshot({ view: '3d', width: 64, height: 64 })
    const second = service.screenshot({ view: '3d', width: 64, height: 64 })
    expect(first).toEqual(second)
  })
})

describe('plan raster determinism', () => {
  it('produces identical draw-op streams across runs', () => {
    const store = makeStoreWithWalls()
    const home = store.getHome()
    const view = fitToBounds(home, 320, 240)

    const ctxA = new RecordingPlanContext()
    const ctxB = new RecordingPlanContext()
    drawPlan(home, null, ctxA, view)
    drawPlan(home, null, ctxB, view)

    expect(ctxA.ops).toEqual(ctxB.ops)
    // Real coverage smoke: both walls stroked with moveTo/lineTo pairs.
    const moves = ctxA.ops.filter(([op]) => op === 'moveTo').length
    const lines = ctxA.ops.filter(([op]) => op === 'lineTo').length
    expect(moves).toBeGreaterThanOrEqual(2)
    expect(lines).toBeGreaterThanOrEqual(2)
  })
})

describe('BrowserCaptureBackend environment guard', () => {
  it('fails loudly outside a DOM instead of silently returning junk', () => {
    if (typeof document !== 'undefined') return
    const backend = new BrowserCaptureBackend()
    expect(() =>
      backend.renderPlan(makeStoreWithWalls().getHome(), 10, 10),
    ).toThrowError(/DOM/)
  })
})
