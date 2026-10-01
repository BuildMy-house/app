/**
 * furniture-lod.ts — Distance-based visibility culling for furniture.
 *
 * Furniture that projects below a few pixels on screen is invisible detail
 * but still costs draw calls, vertex shading, and shadow-pass work. Each
 * rendered frame, every furniture object — individual `furniture:<id>`
 * meshes/groups AND whole InstancedMesh furniture groups — gets a cheap
 * apparent-screen-size estimate (pinhole projection):
 *
 *   px ≈ worldSize / (2 · distance · tan(fov/2)) · viewportHeightPx
 *
 * Objects whose estimate falls below the caller's threshold are hidden
 * (`visible = false`); objects this pass previously hid are restored once
 * they grow past the threshold again. Thresholds arrive pre-converted to
 * pixels by the caller from a screen-height fraction (see viewport-quality.ts),
 * and transparent/glass furniture uses a separate, higher threshold (based on
 * standard screen-space LOD culling practice). Walls, floors, ceilings,
 * roofs, and everything else never match, so only furniture is ever touched.
 * A threshold of 0 disables culling entirely.
 *
 * Documented scope cuts / tradeoffs:
 *   - The pass runs inside View3D's render-on-demand funnel (draw()), i.e.
 *     only on frames that are actually drawn (store edits, camera moves,
 *     orbit ticks) — not on a persistent per-frame timer. That matches the
 *     app's render-on-demand architecture: idle frames cost nothing anyway.
 *   - LOD is applied at whole-InstancedMesh-group granularity: the group's
 *     visibility decision takes the MAX apparent size over its instances,
 *     so a group stays visible while ANY instance is big enough on screen
 *     (no per-instance hiding within one InstancedMesh). The estimate is
 *     biased toward NOT culling — the worst case is a missed cull, never a
 *     visibly popping-in object.
 *   - Apparent size uses each object's cached bounding box (max dimension)
 *     and instance translation columns — no exact AABB projection.
 *   - viewportHeightPx is the renderer's drawing-buffer height (CSS size ×
 *     pixel ratio). The interaction-mode pixel-ratio drop therefore culls
 *     slightly more mid-gesture, which is when culling pays most.
 *   - Sub-threshold furniture is also unclickable (raycast skips invisible
 *     objects) — it is sub-pixel, so there is nothing meaningful to hit.
 */

import * as THREE from 'three'

export interface FurnitureLodStats {
  /** Furniture objects hidden by this pass (delta, not total). */
  hidden: number
  /** Furniture objects restored to visible by this pass. */
  restored: number
}

/**
 * Estimate the apparent height in pixels of a world-space object of size
 * `worldSize` at `distance` from the camera (same units, e.g. cm), with a
 * vertical FOV of `fovDeg` on a `viewportHeightPx`-tall viewport. Returns
 * Infinity at or inside the camera plane, 0 for degenerate inputs.
 */
export function estimateApparentSizePx(
  distance: number,
  worldSize: number,
  fovDeg: number,
  viewportHeightPx: number,
): number {
  if (!(distance > 0) || !(worldSize > 0)) return worldSize > 0 ? Infinity : 0
  if (!(viewportHeightPx > 0) || !(fovDeg > 0 && fovDeg < 180)) return 0
  const halfFovTan = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2)
  return (worldSize / (2 * distance * halfFovTan)) * viewportHeightPx
}

/**
 * True when the object should be hidden: its apparent size is below
 * `thresholdPx`. A threshold of 0 (or less) disables culling entirely.
 */
export function shouldCullFurniture(
  distance: number,
  worldSize: number,
  fovDeg: number,
  viewportHeightPx: number,
  thresholdPx: number,
): boolean {
  if (thresholdPx <= 0) return false
  return estimateApparentSizePx(distance, worldSize, fovDeg, viewportHeightPx) < thresholdPx
}

/**
 * True if any material on this object (or, for InstancedMesh, its own
 * material) is transparent or has nonzero transmission (glass). Used to route
 * furniture to the higher transparentLodCullScreenFraction cull threshold —
 * blending artifacts are more visible at tiny sizes than opaque popping is.
 */
export function hasTransparentMaterial(object: THREE.Object3D): boolean {
  const walk = (node: THREE.Object3D): boolean => {
    const mesh = node as THREE.Mesh
    if (mesh.isMesh) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        if (material.transparent || (material as THREE.MeshPhysicalMaterial).transmission > 0) {
          return true
        }
      }
    }
    for (const child of node.children) {
      if (walk(child)) return true
    }
    return false
  }
  return walk(object)
}

// Bounding box (max dimension + world center) of individual furniture
// objects, invalidated when the object's world matrix changes — the scene
// delta path moves furniture by setting position/rotation directly, so a
// permanent cache would cull objects from their stale, pre-move position.
// InstancedMesh groups are NOT cached here: per-instance matrices mutate
// via setMatrixAt without touching object.matrixWorld, leaving no cheap
// validity signal — their bounds are recomputed every pass instead (a
// per-instance loop over instance translations, trivially cheap).
const boundsCache = new WeakMap<
  THREE.Object3D,
  { matrix: number[]; center: THREE.Vector3; size: number }
>()

function individualBounds(object: THREE.Object3D): { center: THREE.Vector3; size: number } {
  object.updateWorldMatrix(true, false)
  const elements = object.matrixWorld.elements
  const cached = boundsCache.get(object)
  if (cached) {
    let same = cached.matrix.length === elements.length
    for (let i = 0; same && i < elements.length; i++) same = cached.matrix[i] === elements[i]
    if (same) return cached
  }
  const box = new THREE.Box3().setFromObject(object)
  const size = new THREE.Vector3()
  box.getSize(size)
  const bounds = {
    matrix: Array.from(elements),
    center: box.getCenter(new THREE.Vector3()),
    size: Math.max(size.x, size.y, size.z),
  }
  boundsCache.set(object, bounds)
  return bounds
}

function individualApparentSizePx(
  object: THREE.Object3D,
  cameraPosition: THREE.Vector3,
  fovDeg: number,
  viewportHeightPx: number,
): number {
  const { center, size } = individualBounds(object)
  // Measure to the bounding box's near surface, not its center: the bias
  // keeps borderline objects visible instead of popping out a frame early.
  const distance = Math.max(0.01, cameraPosition.distanceTo(center) - size / 2)
  return estimateApparentSizePx(distance, size, fovDeg, viewportHeightPx)
}

function instancedGroupApparentSizePx(
  mesh: THREE.InstancedMesh,
  cameraPosition: THREE.Vector3,
  fovDeg: number,
  viewportHeightPx: number,
): number {
  const geometry = mesh.geometry
  // Instance matrices are read relative to the mesh's world transform; make
  // sure it is current even on the first pass after a scene rebuild (before
  // any render has refreshed matrixWorld).
  mesh.updateWorldMatrix(true, false)
  if (geometry.boundingBox === null) geometry.computeBoundingBox()
  const geoBox = geometry.boundingBox!
  const size = new THREE.Vector3()
  geoBox.getSize(size)
  const instanceSize = Math.max(size.x, size.y, size.z)
  const geoCenter = geoBox.getCenter(new THREE.Vector3())
  // Instance matrices in this app carry the full world transform (the mesh
  // object itself sits at the origin); compose matrixWorld anyway so the
  // estimate stays correct if that ever changes.
  const matrix = new THREE.Matrix4()
  const world = new THREE.Vector3()
  let maxPx = 0
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix)
    world.copy(geoCenter).applyMatrix4(matrix).applyMatrix4(mesh.matrixWorld)
    const distance = Math.max(0.01, cameraPosition.distanceTo(world) - instanceSize / 2)
    maxPx = Math.max(maxPx, estimateApparentSizePx(distance, instanceSize, fovDeg, viewportHeightPx))
  }
  return maxPx
}

function isInstancedFurniture(object: THREE.Object3D): object is THREE.InstancedMesh {
  return (
    object instanceof THREE.InstancedMesh &&
    Array.isArray(object.userData.instanceFurnitureIds)
  )
}

/**
 * One LOD pass over the scene. Hides furniture below the pixel threshold
 * and restores furniture this pass previously hid (tracked in
 * `hiddenByLod`, a WeakSet owned by the caller — objects hidden for other
 * reasons, e.g. per-level filtering, are never forced visible). Returns
 * per-call deltas for cheap logging/metrics.
 */
export function applyFurnitureLod(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  viewportHeightPx: number,
  thresholdPx: number,
  transparentThresholdPx: number,
  hiddenByLod: WeakSet<THREE.Object3D>,
): FurnitureLodStats {
  const stats: FurnitureLodStats = { hidden: 0, restored: 0 }
  const cameraPosition = camera.position
  const fovDeg = camera.fov
  const cullDecision = (object: THREE.Object3D, apparentPx: number, limitPx: number): void => {
    const cull = limitPx > 0 && apparentPx < limitPx
    if (cull) {
      if (!hiddenByLod.has(object)) {
        hiddenByLod.add(object)
        object.visible = false
        stats.hidden++
      }
    } else if (hiddenByLod.has(object)) {
      // Only unhide what we hid — never override user/level visibility.
      hiddenByLod.delete(object)
      object.visible = true
      stats.restored++
    }
  }
  // Manual descent (not scene.traverse) so furniture subtrees are evaluated
  // once at the group level instead of node-by-node.
  const walk = (object: THREE.Object3D): void => {
    if (isInstancedFurniture(object)) {
      cullDecision(
        object,
        instancedGroupApparentSizePx(object, cameraPosition, fovDeg, viewportHeightPx),
        hasTransparentMaterial(object) ? transparentThresholdPx : thresholdPx,
      )
      return
    }
    if (object.name.startsWith('furniture:')) {
      cullDecision(
        object,
        individualApparentSizePx(object, cameraPosition, fovDeg, viewportHeightPx),
        hasTransparentMaterial(object) ? transparentThresholdPx : thresholdPx,
      )
      return
    }
    for (const child of object.children) walk(child)
  }
  walk(scene)
  return stats
}
