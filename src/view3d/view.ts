import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js'
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js'
import { HomeModel } from '../core/model'
import { HomeStore } from '../core/store'
import { DEFAULT_WALL_HEIGHT_CM, type Furniture, type NormalizedHomeState } from '../core/home'
import { CameraDirector, type CameraPatch, type CameraPresetName } from './cameras'
import { buildScene, defaultModelUrlResolver, type ModelUrlResolver } from './scene'
import { observeStore } from './watch'
import { computeHomeBounds } from '../core/top-camera-follower'
import {
  DEFAULT_VIEWPORT_QUALITY,
  loadViewportQuality,
  saveViewportQuality,
  type ViewportQuality,
} from './viewport-quality'
import {
  HDRI_PRESETS,
  HdriEnvironment,
  loadHdriPresetId,
  saveHdriPresetId,
  type HdriPresetId,
} from './hdri-environment'
import { telemetry } from '../telemetry/logger'
import type { RenderingMetrics } from '../telemetry/events'
import {
  applySceneUpdate,
  computeSceneUpdates,
  recordFullRebuild,
  recordSceneDelta,
  snapshotDeltaMetrics,
  type SceneUpdateType,
} from './scene-delta'
import { exportViewportAsImage } from '../export/quick-preview'

// Per-texture memory estimate for the telemetry textureMemoryMB figure (1024×1024 RGBA).
const ESTIMATED_TEXTURE_MB = 1
const INTERACTION_PIXEL_RATIO = 0.75
// Furniture gizmo handle geometry and 3D floor-drag magnetism, in world cm.
const GIZMO_ARROW_LENGTH_CM = 90
const GIZMO_RING_RADIUS_CM = 65
const GIZMO_HANDLE_RADIUS_CM = 7
const FLOOR_DRAG_SNAP_CM = 10

export interface View3DOptions {
  /** DOM container; when absent the view stays a headless scene graph. */
  container?: HTMLElement
  width?: number
  height?: number
  /** Initial viewport quality; defaults to the persisted setting. */
  quality?: ViewportQuality
  /**
   * Resolve a furniture modelPath to a fetchable URL. Defaults to bundled
   * `assets/<path>`; pass a resolver that maps user blob keys to blob URLs.
   */
  modelUrlResolver?: ModelUrlResolver
  /**
   * When truthy, a non-drag click on the 3D floor places furniture instead of
   * selecting. Driven by the catalog's armed (place) state.
   */
  isPlacing?: () => boolean
  /** Called with the model-space floor point of a placement click. */
  onFloorClick?: (point: { x: number; y: number }) => void
}

/**
 * Deterministic 3D view over one HomeStore: full-scene rebuild on every
 * store change, render strictly on demand (store change, camera command,
 * resize) — never on a timer (ws-protocol determinism rules).
 */
export class View3D {
  readonly director: CameraDirector
  readonly domElement: HTMLCanvasElement | undefined

  private _scene: THREE.Scene
  private readonly perspectiveCamera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer | undefined
  private controls: OrbitControls | undefined
  private readonly unobserve: () => void
  private _isFirstBuild = true
  private _lastSelectionKey = ''
  private _animationFrame: number | undefined
  private readonly resizeObserver?: ResizeObserver
  // Frame time tracking: sliding window of 100 samples, reported every 30s.
  private _frameSamples: number[] = []
  private _frameLastTime = 0
  private _frameReportTimer: ReturnType<typeof setTimeout> | undefined
  // Rendering metrics: sampled every 30 frames, latest snapshot reported with the 30s frame-time report.
  private _metricsFrameCount = 0
  private _lastMetrics: RenderingMetrics | undefined
  // Delta metrics: 60s aggregation window, reported via telemetry.sceneDeltaMetrics.
  private _deltaReportTimer: ReturnType<typeof setTimeout> | undefined
  private readonly handleResize = (): void => {
    const container = this.domElement?.parentElement
    if (!container) return
    this.resizeTo(container.clientWidth || 800, container.clientHeight || 600)
  }
  private _quality: ViewportQuality
  private _interacting = false
  private _settleTimer: ReturnType<typeof setTimeout> | undefined
  private _envPreset: HdriPresetId
  private _requestedEnvPreset: HdriPresetId
  private environment: HdriEnvironment | undefined
  private readonly modelUrlResolver: ModelUrlResolver
  private readonly model: HomeModel
  private readonly pointerDown = { x: 0, y: 0 }
  private furnitureDrag: { id: string; x: number; y: number; start: { x: number; y: number } } | null = null
  private gizmo: THREE.Group | undefined
  private gizmoDrag: {
    id: string
    kind: 'x' | 'y' | 'z' | 'ring'
    origin: THREE.Vector3
    axis: THREE.Vector3
    normal: THREE.Vector3
    start: THREE.Vector3
    value0: number
  } | null = null
  private readonly isPlacing?: () => boolean
  private readonly onFloorClick?: (point: { x: number; y: number }) => void
  private _lastHome: NormalizedHomeState | null = null
  private _lastDeltaMs = 0
  private _activeLevel: string | null = null
  private _isOutsideView = false
  private _showRoof = true
  private _lightIntensity = 1
  // Only changes when the scene graph is rebuilt, never during camera orbit.
  private _instancedMeshCount = 0
  private _lastDrawCalls = 0
  private _lastTriangleCount = 0
  private _lastRenderCpuMs = 0
  private _renderSamples: number[] = []
  private _composer: EffectComposer | undefined
  private _bloomPass: UnrealBloomPass | undefined

  constructor(
    private readonly store: HomeStore,
    options: View3DOptions = {},
  ) {
    this.model = new HomeModel(store)
    this.director = new CameraDirector(store, this.model)
    this.modelUrlResolver = options.modelUrlResolver ?? defaultModelUrlResolver
    this.isPlacing = options.isPlacing
    this.onFloorClick = options.onFloorClick
    this._scene = buildScene(store.getHome(), {
      modelUrlResolver: this.modelUrlResolver,
      onModelReady: () => this.startAnimationLoop(),
      onTextureReady: () => this.startAnimationLoop(),
      activeLevel: this._activeLevel,
      isOutsideView: this._isOutsideView,
      showRoof: this._showRoof,
      lightIntensity: this._lightIntensity,
    })
    this.countInstancedMeshes()
    this.perspectiveCamera = new THREE.PerspectiveCamera(63, 4 / 3, 1, 500_000)
    this.perspectiveCamera.rotation.order = 'YXZ'
    this.unobserve = observeStore(store, () => this.onStoreChanged())
    this.syncCamera()

    // Persisted quality when the caller didn't supply one.
    let stored: ViewportQuality | undefined
    try {
      stored = loadViewportQuality()
    } catch {
      stored = undefined
    }
    this._quality = options.quality ?? stored ?? { ...DEFAULT_VIEWPORT_QUALITY }
    this._envPreset = loadHdriPresetId()
    this._requestedEnvPreset = this._envPreset

    const container = options.container
    if (container) {
      const width = options.width ?? (container.clientWidth || 800)
      const height = options.height ?? (container.clientHeight || 600)
      const renderer = new THREE.WebGLRenderer({
        antialias: this._quality.antialias,
        powerPreference: 'high-performance',
      })
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.1
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._quality.pixelRatioCap))
      renderer.setSize(width, height)
      renderer.shadowMap.enabled = true
      // PCFSoftShadowMap is deprecated in r185+; PCFShadowMap now uses Vogel
      // disk sampling with IGN noise, giving the same soft-shadow quality.
      renderer.shadowMap.type = THREE.PCFShadowMap
      // Shadow-casting geometry/lights are static during orbit — only camera
      // moves. Re-rendering the full shadow pass every orbit frame (three.js's
      // default) was the single biggest cost in the render loop; gate it to
      // fire only when the scene/quality actually changes (see needsUpdate
      // sets in applyQualityToScene() and onStoreChanged()).
      renderer.shadowMap.autoUpdate = false
      renderer.shadowMap.needsUpdate = true
      container.appendChild(renderer.domElement)
      this.renderer = renderer
      this.applyQualityToScene()
      this.applyEnvironment()
      this.setupPostProcessing()

      renderer.domElement.addEventListener('webglcontextlost', () => telemetry.webglContextLost())

      this.controls = new OrbitControls(this.perspectiveCamera, renderer.domElement)
      this.controls.enableDamping = true
      this.controls.dampingFactor = 0.1
      this.controls.target.set(0, 0, 0)
      this.controls.minDistance = 50
      this.controls.maxDistance = 50_000
      this.controls.update()
      // Drive redraws from control interaction. Must NOT call render() here:
      // render() draws, the loop below calls update(); update() dispatches
      // 'change', so calling render() from this handler would recurse forever.
      this.controls.addEventListener('change', () => {
        this.enterInteractionMode()
        this.startAnimationLoop()
      })

      window.addEventListener('resize', this.handleResize)

      // Resize the canvas whenever the container box changes — covers divider
      // drags, panel show/hide, catalog collapse, and window resize in one
      // place instead of wiring every layout change through the app shell.
      this.resizeObserver = new ResizeObserver(() => {
        const w = container.clientWidth || 800
        const h = container.clientHeight || 600
        this.resizeTo(w, h)
      })
      this.resizeObserver.observe(container)

      // Click-to-select: a pointerup that didn't drag (orbit) raycasts the
      // scene and selects the hit furniture/wall. Selection drives the camera
      // recenter in onStoreChanged(); OrbitControls swipe is left untouched.
      renderer.domElement.addEventListener('pointerdown', (e) => {
        this.pointerDown.x = e.clientX
        this.pointerDown.y = e.clientY
        if (e.button !== 0 || (this.onFloorClick && this.isPlacing?.())) return
        if (this.beginGizmoDrag(e)) return
        const id = this.pickFurnitureId(e)
        const item = id && this.store.getHome().furniture.find((f) => f.id === id)
        const start = item && this.floorPoint(e)
        if (!item || !start) return
        this.furnitureDrag = { id: item.id, x: item.x, y: item.y, start }
        this.store.beginCompoundEdit()
        this.model.setSelection([item.id])
        this.controls!.enabled = false
        renderer.domElement.setPointerCapture(e.pointerId)
      })
      renderer.domElement.addEventListener('pointermove', (e) => {
        if (this.gizmoDrag) {
          this.updateGizmoDrag(e)
          return
        }
        if (!this.furnitureDrag) return
        const point = this.floorPoint(e)
        if (!point) return
        const drag = this.furnitureDrag
        const naive = {
          x: drag.x + point.x - drag.start.x,
          y: drag.y + point.y - drag.start.y,
        }
        const item = this.store.getHome().furniture.find((f) => f.id === drag.id)
        this.model.updateFurniture(drag.id, item ? this.snapFloorTarget(item, naive) : naive)
      })
      renderer.domElement.addEventListener('pointerup', (e) => {
        if (this.gizmoDrag) {
          this.gizmoDrag = null
          this.store.endCompoundEdit()
          this.controls!.enabled = true
          return
        }
        if (this.furnitureDrag) {
          this.furnitureDrag = null
          this.store.endCompoundEdit()
          this.controls!.enabled = true
          return
        }
        const moved = Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y)
        if (moved > 5) return
        if (this.onFloorClick && this.isPlacing?.()) {
          const p = this.floorPoint(e)
          if (p) this.onFloorClick(p)
          return
        }
        this.pick(e)
      })
      renderer.domElement.addEventListener('pointercancel', () => {
        if (this.gizmoDrag) {
          this.gizmoDrag = null
          this.store.endCompoundEdit()
          this.controls!.enabled = true
        }
        if (!this.furnitureDrag) return
        this.furnitureDrag = null
        this.store.endCompoundEdit()
        this.controls!.enabled = true
      })

      // Apply the empty-home framing after OrbitControls exists; the initial
      // camera sync cannot set a useful orbit target without controls.
      this.setActivePreset(this.director.getActivePreset())
    }

    this.ensureGizmo()
  }

  get scene(): THREE.Scene {
    return this._scene
  }

  get camera(): THREE.PerspectiveCamera {
    return this.perspectiveCamera
  }

  setGridVisible(visible: boolean): void {
    const grid = this._scene.getObjectByName('ground-grid')
    if (grid) {
      grid.visible = visible
      this.render()
    }
  }

  /** Filter the 3D scene to show only objects on the given level (null = all). */
  setActiveLevel(id: string | null): void {
    if (this._activeLevel === id) return
    this._activeLevel = id
    this.rebuild()
  }

  get isOutsideView(): boolean {
    return this._isOutsideView
  }

  /**
   * Toggle outside/whole-model view. Ceilings normally stay hidden while
   * working inside a floor; outside view shows every room's ceiling for a
   * fully enclosed look (see shouldShowCeiling in scene.ts).
   */
  setOutsideView(value: boolean): void {
    if (this._isOutsideView === value) return
    this._isOutsideView = value
    this.rebuild()
  }

  get showRoof(): boolean {
    return this._showRoof
  }

  /**
   * Roof cutaway / hide-roof mode: hides every roof mesh so the interior is
   * visible from perspective/observer cameras without a section-camera or
   * exporter-side omission hack. Independent of isOutsideView/activeLevel —
   * a full scene rebuild picks it up the same way those do.
   */
  setRoofVisible(value: boolean): void {
    if (this._showRoof === value) return
    this._showRoof = value
    this.rebuild()
  }

  get lightIntensity(): number {
    return this._lightIntensity
  }

  /**
   * General lighting control (Ticket 5b): a multiplier on every light's base
   * intensity (hemisphere/ambient/directional/fill), for exposure adjustment
   * without editing the persisted home environment. Independent of
   * home.environment.lightColor, which controls color/tint, not brightness.
   */
  setLightIntensity(value: number): void {
    if (this._lightIntensity === value) return
    this._lightIntensity = value
    this.rebuild()
  }

  /** Wall-clock ms of the last delta-applied store change (0 after a rebuild). */
  get lastDeltaMs(): number {
    return this._lastDeltaMs
  }

  /** Switch which preset the viewport shows ("top" | "observer"). */
  setActivePreset(name: CameraPresetName): void {
    const cam = this.director.usePreset(name)

    if (this.controls) {
      this.cancelAnimation()
      const home = this.store.getHome()
      const hasContent = this.hasSceneContent(home)

      this.controls.enableDamping = false
      if (hasContent) {
        const targetPos = new THREE.Vector3(cam.x, cam.z, cam.y)
        // Orbit around the home's bounds center (plan x,y → world x,z; height → y).
        // Keeps the house framed for both presets, including the top camera which
        // follows content in the store but would otherwise look at the origin.
        const bounds = computeHomeBounds(home)
        const center = new THREE.Vector3(
          (bounds.minX + bounds.maxX) / 2,
          (bounds.minZ + bounds.maxZ) / 2,
          (bounds.minY + bounds.maxY) / 2,
        )
        this.perspectiveCamera.position.copy(targetPos)
        this.controls.target.copy(center)
        this.controls.update()
      } else {
        // Nothing to frame yet — computeHomeBounds falls back to a tiny box
        // near the origin, and for some presets that box sits directly
        // beneath the camera, collapsing the "look at bounds center" orbit
        // target to a near-vertical pitch (the 3D view of an empty home
        // rendering as an uninformative wall-to-wall ground-plane gray).
        // Use the preset's actual intended orientation instead.
        this.applyCameraState(cam)
        const dir = new THREE.Vector3()
        this.perspectiveCamera.getWorldDirection(dir)
        const emptyTarget = this.perspectiveCamera.position.clone().addScaledVector(dir, 500)
        emptyTarget.y = 0
        this.controls.target.copy(emptyTarget)
        this.controls.update()
      }
      this.controls.enableDamping = true
    } else {
      this.applyCameraState(cam)
    }
    this.render()
  }

  setCamera(patch: CameraPatch): void {
    this.director.setCamera(patch)
    this.syncCamera()
    this.render()
  }

  /**
   * Reframe the view onto the home's bounds (Fit button / first-geometry
   * autofit). The camera state change goes through CameraDirector.fitToContent
   * (model path, so undo/validation stay consistent); the viewport then
   * mirrors the stored state and points the orbit target at the same center.
   */
  fitToContent(): void {
    const { state, center } = this.director.fitToContent(this.store.getHome())
    if (this.controls) {
      this.cancelAnimation()
      this.controls.enableDamping = false
      this.applyCameraState(state)
      this.controls.target.set(center.x, center.y, center.z)
      this.controls.update()
      this.controls.enableDamping = true
    } else {
      this.applyCameraState(state)
    }
    this.render()
  }

  resizeTo(width: number, height: number): void {
    if (!this.renderer) return
    this.renderer.setSize(width, height)
    this._composer?.setSize(width, height)
    this.perspectiveCamera.aspect = width / height
    this.perspectiveCamera.updateProjectionMatrix()
    this.render()
  }

  /** Current viewport quality settings. */
  get quality(): ViewportQuality {
    return { ...this._quality }
  }

  /**
   * Apply a viewport quality preset live. Persists the choice; affects the
   * renderer pixel ratio, shadow map resolution, fog, and (on rebuild) texture
   * anisotropy. Antialias changes need a new context, so they apply on the
   * next full page/view recreation — everything else is immediate.
   */
  applyQuality(quality: ViewportQuality): void {
    this._quality = { ...quality }
    try {
      saveViewportQuality(this._quality)
    } catch {
      // Persistence is best-effort.
    }
    if (!this.renderer) return
    const cap = this._quality.pixelRatioCap
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap))
    this.applyQualityToScene()
    this.setupPostProcessing()
    this.render()
  }

  private applyQualityToScene(): void {
    if (!this.renderer) return
    this.renderer.shadowMap.enabled = true
    const size = this._quality.shadowMapSize
    this._scene.traverse((object) => {
      if ((object as THREE.DirectionalLight).isDirectionalLight) {
        const light = object as THREE.DirectionalLight
        light.shadow.mapSize.set(size, size)
        // Force reallocation of the shadow map at the new resolution.
        if (light.shadow.map) light.shadow.map.dispose()
        light.shadow.map = null
      }
    })
    // Fog density: 0 disables fog, >0 uses FogExp2.
    this._scene.fog =
      this._quality.fogDensity > 0
        ? new THREE.FogExp2(
            this._scene.background instanceof THREE.Color ? this._scene.background : 0xcce4fc,
            this._quality.fogDensity,
          )
        : null
    // autoUpdate is off (see renderer setup) — force one shadow pass now that
    // shadow-casting geometry/resolution may have changed.
    this.renderer.shadowMap.needsUpdate = true
  }

  /**
   * Build (or rebuild) the post-processing EffectComposer from the current
   * viewport quality settings. Disposes any previous composer first.
   *
   * Pass chain: RenderPass → AO (SSAO/GTAO) → Bloom → OutputPass.
   * When bloom and ao are both off the composer is left undefined and the
   * render loop falls back to a plain renderer.render() call.
   */
  private setupPostProcessing(): void {
    this._composer?.dispose()
    this._composer = undefined
    this._bloomPass = undefined

    const renderer = this.renderer
    if (!renderer) return

    const { bloom, ao } = this._quality
    if (!bloom && ao === 'none') return

    const size = new THREE.Vector2()
    renderer.getSize(size)

    const composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(this._scene, this.perspectiveCamera))

    // Ambient occlusion — subtle contact shadows.
    if (ao === 'gtao') {
      const gtao = new GTAOPass(this._scene, this.perspectiveCamera, size.x, size.y)
      gtao.output = GTAOPass.OUTPUT.Default
      composer.addPass(gtao)
    } else if (ao === 'ssao') {
      const ssao = new SSAOPass(this._scene, this.perspectiveCamera, size.x, size.y)
      ssao.kernelRadius = 16
      ssao.minDistance = 0.005
      ssao.maxDistance = 0.1
      composer.addPass(ssao)
    }

    // Bloom — subtle glow on bright surfaces.
    if (bloom) {
      const bloomPass = new UnrealBloomPass(size, 0.4, 0.5, 0.85)
      this._bloomPass = bloomPass
      composer.addPass(bloomPass)
    }

    // OutputPass applies the renderer's toneMapping + outputColorSpace at the
    // end of the chain so intermediate passes work in linear HDR.
    composer.addPass(new OutputPass())

    this._composer = composer
  }

  /** Current HDRI environment preset id (a viewport pref, not home state). */
  getEnvironmentPreset(): HdriPresetId {
    return this._envPreset
  }

  /** Switch HDRI environment; persists the choice and re-renders. */
  setEnvironmentPreset(id: HdriPresetId): void {
    if (!(id in HDRI_PRESETS) || id === this._requestedEnvPreset) return
    this._requestedEnvPreset = id
    this.environment?.resetFailure(id)
    this.applyEnvironment(id)
    this.render()
  }

  /** True once the home has any drawn wall, room, furniture, or dimension line. */
  private hasSceneContent(home: NormalizedHomeState = this.store.getHome()): boolean {
    return (
      home.walls.length > 0 ||
      home.rooms.length > 0 ||
      home.furniture.length > 0 ||
      home.dimensionLines.length > 0
    )
  }

  /**
   * Apply the current HDRI preset to the live scene. Cached presets apply
   * synchronously (no flash between rebuild and env); first load is async and
   * falls back to the flat sky color until the .hdr arrives.
   *
   * Skipped entirely on an empty home: a blurry, low-res HDRI backdrop behind
   * nothing but the ground plane looks broken, so an empty scene keeps
   * buildScene's flat sky-blue clear color instead.
   */
  private applyEnvironment(id: HdriPresetId = this._requestedEnvPreset): void {
    const renderer = this.renderer
    if (!renderer) return // headless: flat scene stays as buildScene made it
    if (!this.hasSceneContent()) return
    if (!this.environment) this.environment = new HdriEnvironment(renderer)
    this.environment
      .applyTo(this._scene, id)
      .then(() => {
        if (this._requestedEnvPreset === id) {
          this._envPreset = id
          saveHdriPresetId(id)
        }
        this.startAnimationLoop()
      })
      .catch(() => {
        // Load failure (offline, missing asset): scene.ts's flat sky color and
        // analytic lights remain — the pre-HDRI look. Reset so switching back
        // to this preset can retry.
        this.environment?.resetFailure(id)
      })
  }

  /** Rebuild the whole scene graph from current store state. */
  rebuild(): void {
    const t0 = performance.now()
    let savedTarget: THREE.Vector3 | undefined
    let savedPosition: THREE.Vector3 | undefined

    if (this.controls && !this._isFirstBuild) {
      savedTarget = this.controls.target.clone()
      savedPosition = this.perspectiveCamera.position.clone()
    }

    if (this.gizmo) this._scene.remove(this.gizmo)
    this.disposeSceneObjects(this._scene)
    this._scene = buildScene(this.store.getHome(), {
      modelUrlResolver: this.modelUrlResolver,
      onModelReady: () => this.startAnimationLoop(),
      onTextureReady: () => this.startAnimationLoop(),
      activeLevel: this._activeLevel,
      isOutsideView: this._isOutsideView,
      showRoof: this._showRoof,
      lightIntensity: this._lightIntensity,
    })
    if (this.gizmo) this._scene.add(this.gizmo)
    this.countInstancedMeshes()
    this.applyQualityToScene()
    this.applyEnvironment()
    this.setupPostProcessing()

    if (this.controls && savedTarget && savedPosition) {
      this.perspectiveCamera.position.copy(savedPosition)
      this.controls.target.copy(savedTarget)
      this.controls.update()
    }

    this._isFirstBuild = false
    this.render()
    recordFullRebuild(performance.now() - t0)
  }

  /**
   * Store-change entry point. Rebuilds the scene, then recenters the camera on
   * the selection only when the selection itself changed (so orbiting/dragging,
   * which never touches the store, never yanks the camera back).
   */
  private onStoreChanged(): void {
    const home = this.store.getHome()
    const key = [...home.selection].sort().join(',')
    const selectionChanged = key !== this._lastSelectionKey
    this._lastSelectionKey = key

    // Compute what actually changed since the last render
    const updates = computeSceneUpdates(this._lastHome, home)

    // Delta path: apply every computed update in place, but only when ALL of
    // them apply cleanly (and none is a 'full-rebuild'). A single failure
    // anywhere falls back to rebuild() for the WHOLE batch — partial applies
    // are simply discarded because rebuild() reconstructs the scene from
    // store state, so nothing double-applies.
    let applied = false
    if (this._lastHome && updates.length > 0 && !updates.some((u) => u.type === 'full-rebuild')) {
      const batchStart = performance.now()
      applied = true
      const deltaTimings: Array<{ type: SceneUpdateType; ms: number }> = []
      for (const update of updates) {
        const t0 = performance.now()
        const ok = applySceneUpdate(this._scene, update, home, this._lastHome, {
          modelUrlResolver: this.modelUrlResolver,
          onModelReady: () => this.startAnimationLoop(),
          onTextureReady: () => this.startAnimationLoop(),
          activeLevel: this._activeLevel,
          isOutsideView: this._isOutsideView,
        })
        if (!ok) {
          applied = false
          break
        }
        deltaTimings.push({ type: update.type, ms: performance.now() - t0 })
      }
      if (applied) {
        for (const { type, ms } of deltaTimings) recordSceneDelta(type, ms)
        this.startAnimationLoop()
      }
      this._lastDeltaMs = applied ? performance.now() - batchStart : 0
      // Delta path moved/changed shadow-casting geometry directly; autoUpdate
      // is off, so force one shadow pass to pick it up.
      if (applied && this.renderer) this.renderer.shadowMap.needsUpdate = true
    }
    if (!applied) this.rebuild()

    this._lastHome = { ...home } // Shallow copy for next frame

    if (selectionChanged && home.selection.length > 0) this.focusSelection()
    this.updateGizmo()
    if (selectionChanged) this.startAnimationLoop()
  }

  /**
   * Recenter the OrbitControls target on the selected furniture/walls (world
   * centroid). Keeps the current camera offset — only the look-at point moves,
   * so the object becomes centered without changing zoom or angle.
   */
  private focusSelection(): void {
    if (!this.controls) return
    const home = this.store.getHome()
    const sel = new Set(home.selection)
    const levels = new Map(home.levels.map((l) => [l.id, l.elevation]))
    const elevOf = (ref?: string | null): number => (ref ? (levels.get(ref) ?? 0) : 0)

    const points: THREE.Vector3[] = []
    for (const item of home.furniture) {
      if (!sel.has(item.id) || item.visible === false) continue
      points.push(
        new THREE.Vector3(
          item.x,
          elevOf(item.levelRef) + (item.elevation ?? 0) + item.height / 2,
          item.y,
        ),
      )
    }
    for (const w of home.walls) {
      if (!sel.has(w.id)) continue
      const h = w.height ?? DEFAULT_WALL_HEIGHT_CM
      points.push(
        new THREE.Vector3(
          (w.xStart + w.xEnd) / 2,
          elevOf(w.levelRef) + h / 2,
          (w.yStart + w.yEnd) / 2,
        ),
      )
    }
    if (points.length === 0) return

    const center = new THREE.Vector3()
    for (const p of points) center.add(p)
    center.multiplyScalar(1 / points.length)

    const offset = this.perspectiveCamera.position.clone().sub(this.controls.target)
    this.perspectiveCamera.position.copy(center.clone().add(offset))
    this.controls.target.copy(center)
    this.controls.update()
    this.startAnimationLoop()
  }

  /**
   * Raycast a click into the scene and select the topmost furniture/wall under
   * the cursor. Names follow the `furniture:<id>` / `wall:<id>` convention set
   * in scene.ts; GLTF children inherit the parent mesh's name after walking up.
   */
  private pick(e: PointerEvent): void {
    if (!this.renderer) return
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.perspectiveCamera)
    const hits = raycaster.intersectObjects(this._scene.children, true)
    for (const hit of hits) {
      // Instanced furniture: resolve the clicked instance to its furniture id
      // (scene.ts stores the per-instance id list in userData).
      if (hit.object instanceof THREE.InstancedMesh && hit.instanceId != null) {
        const ids = hit.object.userData.instanceFurnitureIds as string[] | undefined
        const id = ids?.[hit.instanceId]
        if (id) {
          this.model.setSelection([id])
          return
        }
      }
      let o: THREE.Object3D | null = hit.object
      while (o) {
        const id = /^furniture:(.+)$/.exec(o.name)?.[1] ?? /^wall:(.+)$/.exec(o.name)?.[1]
        if (id) {
          this.model.setSelection([id])
          return
        }
        o = o.parent
      }
    }
  }

  private pickFurnitureId(e: PointerEvent): string | null {
    if (!this.renderer) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.perspectiveCamera)
    for (const hit of raycaster.intersectObjects(this._scene.children, true)) {
      if (hit.object instanceof THREE.InstancedMesh && hit.instanceId != null) {
        const id = (hit.object.userData.instanceFurnitureIds as string[] | undefined)?.[hit.instanceId]
        if (id) return id
      }
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
        const id = /^furniture:(.+)$/.exec(o.name)?.[1]
        if (id) return id
        if (/^wall:/.test(o.name)) break
      }
    }
    return null
  }

  /**
   * Raycast a click onto the floor plane (world y = 0) and return the model
   * point (plan x → world x, plan y → world z). Returns null if the ray is
   * parallel to the floor. Used for 3D furniture placement.
   */
  private floorPoint(e: PointerEvent): { x: number; y: number } | null {
    if (!this.renderer) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.perspectiveCamera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const hit = new THREE.Vector3()
    if (!raycaster.ray.intersectPlane(plane, hit)) return null
    return { x: hit.x, y: hit.z }
  }

  private ensureGizmo(): THREE.Group {
    if (!this.gizmo) {
      const g = new THREE.Group()
      g.name = 'furniture-gizmo'
      g.visible = false
      const axes: Array<['x' | 'y' | 'z', THREE.Vector3, number]> = [
        ['x', new THREE.Vector3(1, 0, 0), 0xff4444],
        ['y', new THREE.Vector3(0, 1, 0), 0x44ff66],
        ['z', new THREE.Vector3(0, 0, 1), 0x4477ff],
      ]
      for (const [kind, dir, color] of axes) {
        const arrow = new THREE.ArrowHelper(
          dir,
          new THREE.Vector3(),
          GIZMO_ARROW_LENGTH_CM,
          color,
          12,
          6,
        )
        arrow.userData.gizmoKind = kind
        arrow.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.Material | undefined
          if (m) {
            m.depthTest = false
            m.depthWrite = false
          }
          o.renderOrder = 10
        })
        g.add(arrow)
        const hit = new THREE.Mesh(
          new THREE.CylinderGeometry(
            GIZMO_HANDLE_RADIUS_CM,
            GIZMO_HANDLE_RADIUS_CM,
            GIZMO_ARROW_LENGTH_CM,
            8,
          ),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
        )
        hit.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
        hit.position.copy(dir).multiplyScalar(GIZMO_ARROW_LENGTH_CM / 2)
        hit.userData.gizmoKind = kind
        g.add(hit)
      }
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(GIZMO_RING_RADIUS_CM, 2.5, 8, 64),
        new THREE.MeshBasicMaterial({
          color: 0xffdd44,
          depthTest: false,
          depthWrite: false,
          transparent: true,
        }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.renderOrder = 10
      ring.userData.gizmoKind = 'ring'
      g.add(ring)
      const ringHit = new THREE.Mesh(
        new THREE.TorusGeometry(GIZMO_RING_RADIUS_CM, GIZMO_HANDLE_RADIUS_CM, 8, 64),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
      )
      ringHit.rotation.x = -Math.PI / 2
      ringHit.userData.gizmoKind = 'ring'
      g.add(ringHit)
      this.gizmo = g
    }
    this._scene.add(this.gizmo)
    return this.gizmo
  }

  private updateGizmo(): void {
    const g = this.gizmo
    if (!g) return
    const home = this.store.getHome()
    const id = home.selection.length === 1 ? home.selection[0] : null
    const item = id ? home.furniture.find((f) => f.id === id) : undefined
    if (!item || item.visible === false) {
      g.visible = false
      return
    }
    const levels = new Map(home.levels.map((l) => [l.id, l.elevation]))
    const levelY = item.levelRef ? levels.get(item.levelRef) ?? 0 : 0
    g.position.set(item.x, levelY + item.elevation + item.height / 2, item.y)
    g.visible = true
  }

  private beginGizmoDrag(e: PointerEvent): boolean {
    if (!this.renderer || !this.gizmo?.visible) return false
    const kind = this.raycastGizmo(e)
    if (!kind) return false
    const home = this.store.getHome()
    const id = home.selection.length === 1 ? home.selection[0] : null
    const item = id ? home.furniture.find((f) => f.id === id) : undefined
    if (!item) return false
    const origin = this.gizmo.position.clone()
    const axis =
      kind === 'x'
        ? new THREE.Vector3(1, 0, 0)
        : kind === 'y'
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1)
    const normal =
      kind === 'ring' ? new THREE.Vector3(0, 1, 0) : this.gizmoDragNormal(axis)
    const start = this.rayPlanePoint(e, origin, normal)
    if (!start) return false
    const value0 =
      kind === 'x' ? item.x : kind === 'y' ? item.elevation : kind === 'z' ? item.y : item.angleDeg
    this.gizmoDrag = { id: item.id, kind, origin, axis, normal, start, value0 }
    this.store.beginCompoundEdit()
    this.controls!.enabled = false
    this.renderer.domElement.setPointerCapture(e.pointerId)
    return true
  }

  private updateGizmoDrag(e: PointerEvent): void {
    const d = this.gizmoDrag
    if (!d) return
    const p = this.rayPlanePoint(e, d.origin, d.normal)
    if (!p) return
    if (d.kind === 'ring') {
      const a0 = Math.atan2(d.start.z - d.origin.z, d.start.x - d.origin.x)
      const a1 = Math.atan2(p.z - d.origin.z, p.x - d.origin.x)
      this.model.updateFurniture(d.id, {
        angleDeg: d.value0 + THREE.MathUtils.radToDeg(a1 - a0),
      })
      return
    }
    const v = d.value0 + p.sub(d.start).dot(d.axis)
    if (d.kind === 'x') this.model.updateFurniture(d.id, { x: v })
    else if (d.kind === 'y') this.model.updateFurniture(d.id, { elevation: v })
    else this.model.updateFurniture(d.id, { y: v })
  }

  private raycastGizmo(e: PointerEvent): 'x' | 'y' | 'z' | 'ring' | null {
    const raycaster = this.pointerRay(e)
    if (!raycaster || !this.gizmo) return null
    for (const hit of raycaster.intersectObject(this.gizmo, true)) {
      for (let o: THREE.Object3D | null = hit.object; o && o !== this.gizmo; o = o.parent) {
        const kind = o.userData.gizmoKind as 'x' | 'y' | 'z' | 'ring' | undefined
        if (kind) return kind
      }
    }
    return null
  }

  private pointerRay(e: PointerEvent): THREE.Raycaster | null {
    if (!this.renderer) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.perspectiveCamera)
    return raycaster
  }

  private rayPlanePoint(
    e: PointerEvent,
    origin: THREE.Vector3,
    normal: THREE.Vector3,
  ): THREE.Vector3 | null {
    const raycaster = this.pointerRay(e)
    if (!raycaster) return null
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      normal.clone().normalize(),
      origin,
    )
    const hit = new THREE.Vector3()
    return raycaster.ray.intersectPlane(plane, hit) ? hit : null
  }

  private gizmoDragNormal(axis: THREE.Vector3): THREE.Vector3 {
    const camDir = new THREE.Vector3()
    this.perspectiveCamera.getWorldDirection(camDir)
    const n = camDir.clone().addScaledVector(axis, -camDir.dot(axis))
    if (n.lengthSq() < 1e-6) return axis.y !== 0 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0)
    return n.normalize()
  }

  // ponytail: local snap checks wall endpoints + furniture edges only (no
  // diagonal-wall projection, fixed 10cm world threshold) — upgrade to
  // snapFurniturePlacement once View3D can read the plan engine's magnetism flag
  private snapFloorTarget(
    item: Furniture,
    naive: { x: number; y: number },
  ): { x: number; y: number } {
    const home = this.store.getHome()
    const xs: number[] = []
    const ys: number[] = []
    for (const w of home.walls) {
      if ((w.levelRef ?? null) !== (item.levelRef ?? null)) continue
      xs.push(w.xStart, w.xEnd)
      ys.push(w.yStart, w.yEnd)
    }
    for (const f of home.furniture) {
      if (f.id === item.id || f.visible === false || (f.levelRef ?? null) !== (item.levelRef ?? null)) continue
      xs.push(f.x - f.width / 2, f.x, f.x + f.width / 2)
      ys.push(f.y - f.depth / 2, f.y, f.y + f.depth / 2)
    }
    const snapAxis = (value: number, half: number, targets: number[]): number => {
      let best = value
      let bestDist = FLOOR_DRAG_SNAP_CM
      for (const t of targets) {
        for (const cand of [t - half, t, t + half]) {
          const dist = Math.abs(cand - value)
          if (dist < bestDist) {
            bestDist = dist
            best = cand
          }
        }
      }
      return best
    }
    return {
      x: snapAxis(naive.x, item.width / 2, xs),
      y: snapAxis(naive.y, item.depth / 2, ys),
    }
  }

  /** Draw the current scene. Does NOT advance controls (that's the loop). */
  render(): void {
    this.draw()
  }

  private draw(): void {
    const renderer = this.renderer
    if (!renderer) return
    const info = renderer.info
    info.autoReset = false
    info.reset()
    const started = performance.now()
    try {
      // While interacting, render straight through the renderer instead of the
      // composer: AO/bloom passes are at their least visible mid-motion and
      // their per-frame cost dominates low-end GPUs. This also avoids the
      // EffectComposer.setSize() render-target reallocation that used to run
      // on every gesture start/end and stalled the first/last frame of each
      // orbit by hundreds of ms.
      if (this._composer && !this._interacting) this._composer.render()
      else renderer.render(this._scene, this.perspectiveCamera)
    } finally {
      this._lastRenderCpuMs = performance.now() - started
      this._renderSamples.push(this._lastRenderCpuMs)
      if (this._renderSamples.length > 100) this._renderSamples.shift()
      this._lastDrawCalls = info.render.calls
      this._lastTriangleCount = info.render.triangles
      info.autoReset = true
      info.reset()
    }
  }

  private enterInteractionMode(): void {
    if (this._settleTimer) {
      clearTimeout(this._settleTimer)
      this._settleTimer = undefined
    }
    if (this._interacting || !this.renderer) return
    this._interacting = true
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, this._quality.pixelRatioCap, 1) * INTERACTION_PIXEL_RATIO,
    )
    // The pixel-ratio drop shrinks the renderer's drawing buffer, and draw()
    // bypasses the composer entirely while _interacting (see draw()), so
    // AO/bloom don't render at all mid-gesture — no EffectComposer.setSize()
    // here: reallocating its render targets on every gesture start stalled
    // the first frame by hundreds of ms.
  }

  private exitInteractionMode(): void {
    if (!this._interacting) return
    this._interacting = false
    if (!this.renderer) return
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._quality.pixelRatioCap))
    // No composer.setSize() on exit either — the composer's targets were never
    // resized, so restoring is just a ratio reset + one full-quality render.
    this.render()
  }

  /**
   * Run the render loop while OrbitControls is animating (inertia/damping).
   * update() is the ONLY place controls advance; it dispatches 'change', which
   * calls startAnimationLoop() — but the guard makes that a no-op while a frame
   * is already queued, so there is no recursion.
   */
  private startAnimationLoop(): void {
    if (this._animationFrame !== undefined) return
    const tick = (): void => {
      this._animationFrame = undefined
      const now = performance.now()
      if (this._frameLastTime > 0) {
        const dt = now - this._frameLastTime
        this._frameSamples.push(dt)
        if (this._frameSamples.length > 100) this._frameSamples.shift()
        if (!this._frameReportTimer) {
          this._frameReportTimer = setTimeout(() => {
            telemetry.frameTime(this._frameSamples)
            if (this._lastMetrics) telemetry.renderingMetrics(this._lastMetrics)
            this._frameSamples = []
            this._lastMetrics = undefined
            this._frameReportTimer = undefined
          }, 30_000)
        }
        if (!this._deltaReportTimer) {
          this._deltaReportTimer = setTimeout(() => {
            const metrics = snapshotDeltaMetrics()
            if (metrics.deltaUpdatesCount + metrics.fullRebuildsCount > 0) {
              telemetry.sceneDeltaMetrics(metrics)
            }
            this._deltaReportTimer = undefined
          }, 60_000)
        }
      }
      this._frameLastTime = now
      const moving = this.controls ? this.controls.update() : false
      this.draw()
      this._metricsFrameCount++
      if (this._metricsFrameCount >= 30) {
        this._metricsFrameCount = 0
        this._lastMetrics = this.collectRenderingMetrics()
      }
      if (!moving && this._interacting && this._settleTimer === undefined) {
        this._settleTimer = setTimeout(() => {
          this._settleTimer = undefined
          this.exitInteractionMode()
        }, 250)
      }
      if (moving) this._animationFrame = requestAnimationFrame(tick)
    }
    this._animationFrame = requestAnimationFrame(tick)
  }

  dispose(): void {
    this.cancelAnimation()
    if (this._frameReportTimer) clearTimeout(this._frameReportTimer)
    if (this._deltaReportTimer) clearTimeout(this._deltaReportTimer)
    if (this._settleTimer) clearTimeout(this._settleTimer)
    this.unobserve()
    this.controls?.dispose()
    this.resizeObserver?.disconnect()
    if (this.renderer) window.removeEventListener('resize', this.handleResize)
    this.environment?.dispose()
    this.environment = undefined
    this._composer?.dispose()
    this._composer = undefined
    this.disposeSceneObjects(this._scene)
    this.renderer?.dispose()
  }

  private cancelAnimation(): void {
    if (this._animationFrame !== undefined) {
      cancelAnimationFrame(this._animationFrame)
      this._animationFrame = undefined
    }
  }

  /** Count THREE.InstancedMesh instances once per scene build (not per metrics sample). */
  private countInstancedMeshes(): void {
    this._instancedMeshCount = 0
    this._scene.traverse((object) => {
      if (object instanceof THREE.InstancedMesh) this._instancedMeshCount++
    })
  }

  /**
   * Snapshot renderer stats from renderer.info (already tracked per frame by
   * Three.js — no extra render work). Called every 30 frames.
   */
  private collectRenderingMetrics(): RenderingMetrics | undefined {
    const renderer = this.renderer
    if (!renderer) return undefined
    const instancedMeshCount = this._instancedMeshCount
    const frameSamples = [...this._frameSamples].sort((a, b) => a - b)
    const renderSamples = [...this._renderSamples].sort((a, b) => a - b)
    const home = this.store.getHome()
    const frameAvg =
      frameSamples.length > 0 ? frameSamples.reduce((a, b) => a + b, 0) / frameSamples.length : 0
    const renderAvg =
      renderSamples.length > 0 ? renderSamples.reduce((a, b) => a + b, 0) / renderSamples.length : 0
    const p95 = (values: number[]): number =>
      values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0
    return {
      drawCalls: this._lastDrawCalls,
      instancedMeshCount,
      triangleCount: this._lastTriangleCount,
      wallCount: home.walls.length,
      furnitureCount: home.furniture.length,
      roomCount: home.rooms.length,
      // ponytail: renderer.info doesn't expose per-texture bytes; 1MB avg per texture (1024×1024 RGBA), refine only if texture memory ever matters
      textureMemoryMB: renderer.info.memory.textures * ESTIMATED_TEXTURE_MB,
      fps: frameAvg > 0 ? Math.round((1000 / frameAvg) * 100) / 100 : 0,
      frameTimeP95Ms: Math.round(p95(frameSamples) * 100) / 100,
      renderCpuMs: Math.round(renderAvg * 100) / 100,
      renderCpuP95Ms: Math.round(p95(renderSamples) * 100) / 100,
      pixelRatio: renderer.getPixelRatio(),
      qualityPreset: this._quality.preset,
      ao: this._quality.ao,
      bloom: this._quality.bloom,
      interacting: this._interacting,
    }
  }

  private syncCamera(): void {
    this.applyCameraState(this.director.getCamera())
  }

  private applyCameraState(cam: {
    x: number
    y: number
    z: number
    yawDeg: number
    pitchDeg: number
    fovDeg: number
  }): void {
    // SH3D HomeComponent3D: world position (planX, heightZ, planY);
    // orientation Ry(PI - yaw) * Rx(-pitch), pitch positive looks down.
    this.perspectiveCamera.position.set(cam.x, cam.z, cam.y)
    this.perspectiveCamera.rotation.y = Math.PI - THREE.MathUtils.degToRad(cam.yawDeg)
    this.perspectiveCamera.rotation.x = -THREE.MathUtils.degToRad(cam.pitchDeg)
    this.perspectiveCamera.fov = cam.fovDeg
    this.perspectiveCamera.updateProjectionMatrix()
  }

  private disposeSceneObjects(scene: THREE.Scene): void {
    scene.traverse((object) => {
      if (object.userData.shared) return
      const obj = object as THREE.Mesh | THREE.LineSegments | THREE.Line
      if (!obj.geometry) return
      obj.geometry.dispose()
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
      for (const material of materials) {
        if (!material) continue
        material.dispose()
      }
    })
  }

  /**
   * Export the current viewport as an image.
   * Instant client-side operation: no server needed.
   */
  exportAsImage(format: 'png' | 'jpeg' = 'png', quality = 0.95): Promise<Blob> {
    if (!this.domElement) {
      return Promise.reject(new Error('View3D: no canvas available for export'))
    }
    return exportViewportAsImage(this.domElement, format, quality)
  }
}
