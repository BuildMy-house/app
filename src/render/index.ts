/**
 * render/ — Unified rendering pipeline barrel export.
 *
 * Re-exports all public types and functions for the dual rendering
 * pipeline (Three.js real-time + LuxCoreRender offline).
 */

export type {
  RenderableScene,
  MaterialDef,
  TextureDef,
  SceneObject,
  BoxPrimitive,
  PolygonPrimitive,
  ExtrudePolygonPrimitive,
  Primitive,
  CameraDef,
  LightDef,
} from './scene-graph'

export {
  buildRenderableScene,
  DEFAULT_WALL_COLOR,
  DEFAULT_FLOOR_COLOR,
  DEFAULT_FURNITURE_COLOR,
  DEFAULT_CEILING_COLOR,
} from './scene-builder'

export { TextureCache, type TextureEntry, type UvParams } from './texture-cache'
