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
import { DEFAULT_WALL_HEIGHT_CM, type NormalizedHomeState } from '../core/home'
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
  private _envPreset: HdriPresetId
  private _requestedEnvPreset: HdriPresetId
  private environment: HdriEnvironment | undefined
  private readonly modelUrlResolver: ModelUrlResolver
  private readonly model: HomeModel
  private readonly pointerDown = { x: 0, y: 0 }
  private readonly isPlacing?: () => boolean
  private readonly onFloorClick?: (point: { x: number; y: number }) => void
  private _lastHome: NormalizedHomeState | null = null
  private _lastDeltaMs = 0
  private _activeLevel: string | null = null
  private _isOutsideView = false
  private _showRoof = true
  private _lightIntensity = 1
  private _showSiteContext = true
  // Only changes when the scene graph is rebuilt, never during camera orbit.
  private _instancedMeshCount = 0
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
      activeLevel: this._activeLevel,
      isOutsideView: this._isOutsideView,
      showRoof: this._showRoof,
      lightIntensity: this._lightIntensity,
      showSiteContext: this._showSiteContext,
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
      this.controls.addEventListener('change', () => this.startAnimationLoop())

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
      })
      renderer.domElement.addEventListener('pointerup', (e) => {
        const moved = Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y)
        if (moved > 5) return
        if (this.onFloorClick && this.isPlacing?.()) {
          const p = this.floorPoint(e)
          if (p) this.onFloorClick(p)
          return
        }
        this.pick(e)
      })

      // Apply the empty-home framing after OrbitControls exists; the initial
      // camera sync cannot set a useful orbit target without controls.
      this.setActivePreset(this.director.getActivePreset())
    }
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

  get showSiteContext(): boolean {
    return this._showSiteContext
  }

  /**
   * Basic exterior site context (Ticket 5d): trees/deck placeholders + ground
   * variation. Only renders in the outside/whole-model view regardless of
   * this flag (see buildScene's isOutsideView gating) — this flag lets the
   * caller suppress it even while outside, e.g. for a clean architectural
   * screenshot.
   */
  setSiteContextVisible(value: boolean): void {
    if (this._showSiteContext === value) return
    this._showSiteContext = value
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

    this.disposeSceneObjects(this._scene)
    this._scene = buildScene(this.store.getHome(), {
      modelUrlResolver: this.modelUrlResolver,
      onModelReady: () => this.startAnimationLoop(),
      activeLevel: this._activeLevel,
      isOutsideView: this._isOutsideView,
      showRoof: this._showRoof,
      lightIntensity: this._lightIntensity,
      showSiteContext: this._showSiteContext,
    })
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
      }
      this._lastDeltaMs = applied ? performance.now() - batchStart : 0
      // Delta path moved/changed shadow-casting geometry directly; autoUpdate
      // is off, so force one shadow pass to pick it up.
      if (applied && this.renderer) this.renderer.shadowMap.needsUpdate = true
    }
    if (!applied) this.rebuild()

    this._lastHome = { ...home } // Shallow copy for next frame

    if (selectionChanged && home.selection.length > 0) this.focusSelection()
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

  /** Draw the current scene. Does NOT advance controls (that's the loop). */
  render(): void {
    if (this._composer) {
      this._composer.render()
    } else {
      this.renderer?.render(this._scene, this.perspectiveCamera)
    }
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
        this._metricsFrameCount++
        if (this._metricsFrameCount >= 30) {
          this._metricsFrameCount = 0
          this._lastMetrics = this.collectRenderingMetrics()
        }
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
      if (this._composer) {
        this._composer.render()
      } else {
        this.renderer?.render(this._scene, this.perspectiveCamera)
      }
      if (moving) this._animationFrame = requestAnimationFrame(tick)
    }
    this._animationFrame = requestAnimationFrame(tick)
  }

  dispose(): void {
    this.cancelAnimation()
    if (this._frameReportTimer) clearTimeout(this._frameReportTimer)
    if (this._deltaReportTimer) clearTimeout(this._deltaReportTimer)
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
    const samples = this._frameSamples
    const avgDt = samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 0
    return {
      drawCalls: renderer.info.render.calls,
      instancedMeshCount,
      triangleCount: renderer.info.render.triangles,
      // ponytail: renderer.info doesn't expose per-texture bytes; 1MB avg per texture (1024×1024 RGBA), refine only if texture memory ever matters
      textureMemoryMB: renderer.info.memory.textures * ESTIMATED_TEXTURE_MB,
      fps: avgDt > 0 ? Math.round((1000 / avgDt) * 100) / 100 : 0,
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
