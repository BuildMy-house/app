import * as THREE from 'three'

/**
 * Square thumbnail render/viewport size. Both prebaked (ingestion-time) and
 * live in-app fallback thumbnails must render at a 1:1 aspect ratio — the
 * orthographic frustum built by frameOrthographicCamera() below is always
 * square too, so nothing gets stretched.
 */
export const THUMBNAIL_RENDER_SIZE = 384

/**
 * Fixed elevated 3/4-view direction (unit vector, model-center -> camera).
 * Tune this by eye against a few real catalog items of very different sizes
 * before finalizing.
 */
const CAMERA_DIRECTION = new THREE.Vector3(2.4, 2.6, 3.2).normalize()
const CAMERA_DISTANCE = 6

/**
 * Frame `camera` (an orthographic camera) on `model`'s current transform
 * (already scaled/rotated/positioned by the caller): elevated 3/4-down
 * view, centered on the model's actual bounding box, with the frustum sized
 * exactly to that bounding box as seen from this camera angle — so the
 * object fills the frame consistently and stays centered regardless of its
 * own real-world size or aspect ratio (tiny items and huge items both work,
 * no hardcoded frustum). The frustum is ALWAYS square (left/right extent
 * equals top/bottom extent) to match a square render target — never make
 * this asymmetric, that's what caused the stretching this replaces.
 */
export function frameOrthographicCamera(
  camera: THREE.OrthographicCamera,
  model: THREE.Object3D,
  padding = 1.15,
): void {
  model.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(model)
  const center = box.getCenter(new THREE.Vector3())

  camera.position.copy(center).addScaledVector(CAMERA_DIRECTION, CAMERA_DISTANCE)
  camera.up.set(0, 1, 0)
  camera.lookAt(center)
  camera.updateMatrixWorld(true)

  const forward = new THREE.Vector3().subVectors(center, camera.position).normalize()
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize()
  const up = new THREE.Vector3().crossVectors(right, forward).normalize()

  let maxRight = 0
  let maxUp = 0
  const corner = new THREE.Vector3()
  const rel = new THREE.Vector3()
  for (let i = 0; i < 8; i++) {
    corner.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    )
    rel.subVectors(corner, center)
    maxRight = Math.max(maxRight, Math.abs(rel.dot(right)))
    maxUp = Math.max(maxUp, Math.abs(rel.dot(up)))
  }

  const half = Math.max(maxRight, maxUp) * padding
  camera.left = -half
  camera.right = half
  camera.top = half
  camera.bottom = -half
  camera.updateProjectionMatrix()
}
