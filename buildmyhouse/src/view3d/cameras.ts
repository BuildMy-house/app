import type { CameraState } from '../core/home'
import { ModelError } from '../core/model'
import type { HomeModel } from '../core/model'
import type { HomeStore } from '../core/store'

export type CameraPresetName = 'top' | 'observer'

export interface CameraPatch {
  x?: number
  y?: number
  z?: number
  yawDeg?: number
  pitchDeg?: number
  fovDeg?: number
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
}
