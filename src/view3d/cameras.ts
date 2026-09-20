import type { CameraState, NormalizedHomeState } from '../core/home'
import { ModelError } from '../core/model'
import type { HomeModel } from '../core/model'
import type { HomeStore } from '../core/store'
import { computeHomeBounds } from '../core/top-camera-follower'

export type CameraPresetName = 'top' | 'observer'

/** Margin over the exact frustum-fit distance (mirrors 2D fitToBounds' 40px margin). */
const FIT_MARGIN = 1.2
/** Observer pitch used when fitting — the stored 11.25° default is the QA grazing-angle bug. */
const FIT_OBSERVER_PITCH_DEG = 40
/** Sit back at least this far even for tiny content (≈ OrbitControls minDistance headroom). */
const FIT_MIN_DISTANCE = 300
/** Stay under OrbitControls.maxDistance (50_000) so the viewport can hold the fit. */
const FIT_MAX_DISTANCE = 49_000

export interface FitFrame {
  /** Camera snapshot as stored (via moveObserverCamera/moveTopCamera). */
  state: CameraState
  /** Orbit target in world coords (planX → x, height → y, planY → z). */
  center: { x: number; y: number; z: number }
}

export interface CameraPatch {
  x?: number
  y?: number
  z?: number
  yawDeg?: number
  pitchDeg?: number
  fovDeg?: number
}

export interface CameraTarget {
  x: number
  y: number
  z: number
}

/**
 * Which SH3D camera ("top" | "observer") the 3D view currently shows.
 * Deliberately NOT part of home state — matches SH3D, where activeCamera is
 * a UI-side concept (ws-protocol keeps schema free of it). All writes go
 * through HomeModel.moveTopCamera/moveObserverCamera so finite validation
 * and undo stay single-sourced in core.
 */
export class CameraDirector {
  private activePreset: CameraPresetName = 'observer'

  constructor(
    private readonly store: HomeStore,
    private readonly model: HomeModel,
  ) {}

  getActivePreset(): CameraPresetName {
    return this.activePreset
  }

  /** ws-protocol set_camera: partial numeric patch onto the ACTIVE camera. */
  setCamera(patch: CameraPatch): void {
    if (this.activePreset === 'top') this.model.moveTopCamera(patch)
    else this.model.moveObserverCamera(patch)
  }

  /** Switch preset and return the resulting camera snapshot. */
  usePreset(name: CameraPresetName): CameraState {
    if (name !== 'top' && name !== 'observer') {
      throw new ModelError(`unknown camera preset: ${String(name)}`)
    }
    this.activePreset = name
    return this.getCamera(name)
  }

  getCamera(name: CameraPresetName = this.activePreset): CameraState {
    const cameras = this.store.getHome().cameras
    return name === 'top' ? cameras.top : cameras.observer
  }

  /**
   * "Frame all objects" (Fit): re-places the ACTIVE camera so the whole home
   * bounds is framed. Bounds come from computeHomeBounds (same source the
   * top-camera follower uses) — content far from the world origin gets framed
   * where it actually is, unlike the fixed stored preset. Keeps the current
   * yaw so fitting never spins the view; the observer pitch resets to a fixed
   * 40° because the stored 11.25° is what produced the QA grazing-angle view.
   * Applied through setCamera → moveObserverCamera/moveTopCamera so finite
   * validation and undo stay single-sourced in core.
   */
  fitToContent(home: NormalizedHomeState): FitFrame {
    return this.fitBounds(computeHomeBounds(home))
  }

  /** Frame one room footprint without disturbing the rest of the home. */
  fitToRoom(home: NormalizedHomeState, roomId: string): FitFrame {
    const room = home.rooms.find((item) => item.id === roomId)
    if (!room) throw new ModelError(`unknown room id: ${roomId}`)
    const scoped = {
      ...home,
      walls: [],
      rooms: [room],
      furniture: [],
      polylines: [],
      dimensionLines: [],
      labels: [],
      roofs: [],
    }
    return this.fitBounds(computeHomeBounds(scoped))
  }

  /** Aim the active camera at a plan-space point while preserving its position. */
  lookAt(target: CameraTarget): CameraState {
    const camera = this.getCamera()
    const dx = target.x - camera.x
    const dy = target.z - camera.z
    const dz = target.y - camera.y
    const groundDistance = Math.hypot(dx, dz)
    this.setCamera({
      yawDeg: (Math.atan2(-dx, dz) * 180) / Math.PI,
      pitchDeg: (Math.atan2(-dy, groundDistance) * 180) / Math.PI,
    })
    return this.getCamera()
  }

  private fitBounds(bounds: ReturnType<typeof computeHomeBounds>): FitFrame {
    const centerX = (bounds.minX + bounds.maxX) / 2
    const centerY = (bounds.minY + bounds.maxY) / 2
    const centerZ = (bounds.minZ + bounds.maxZ) / 2
    const halfDiagonal =
      Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ) / 2

    const cam = this.getCamera()
    // Sphere-in-frustum fit: r/sin(fov/2) frames the bounding sphere at any
    // aspect ratio; the margin adds breathing room like the 2D fit's 40px.
    const fit = halfDiagonal / Math.sin((cam.fovDeg * Math.PI) / 360)
    const distance = Math.min(Math.max(fit * FIT_MARGIN, FIT_MIN_DISTANCE), FIT_MAX_DISTANCE)

    const yaw = (cam.yawDeg * Math.PI) / 180
    const pitchDeg = this.activePreset === 'top' ? cam.pitchDeg : FIT_OBSERVER_PITCH_DEG
    const pitch = (pitchDeg * Math.PI) / 180
    const groundDistance = distance * Math.cos(pitch)
    // Placement formulas mirror followTopCamera (plan x,y + height coords).
    this.setCamera({
      x: centerX + Math.sin(yaw) * groundDistance,
      y: centerY - Math.cos(yaw) * groundDistance,
      z: centerZ + Math.sin(pitch) * distance,
      yawDeg: cam.yawDeg,
      pitchDeg,
    })
    return {
      state: this.getCamera(),
      // CameraState is (planX, planY, height); world is (planX, height, planY).
      center: { x: centerX, y: centerZ, z: centerY },
    }
  }
}
