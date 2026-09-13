/**
 * RenderableScene — unified scene description consumed by both
 * Three.js (real-time PBR) and LuxCoreRender (offline path-trace).
 *
 * Conventions:
 * - All positions/lengths in centimetres (matches SH3D)
 * - Colours stored as sRGB uint32 (0xRRGGBB) for SH3D compat
 * - Texture references are relative file paths ("textures/wood-oak.png")
 *   Resolved by the caller relative to the scene folder root.
 */

// ── Texture ─────────────────────────────────────────────────────

export interface TextureDef {
  /** Unique key, e.g. "tex_wall_0" */
  id: string;
  /** Relative path from scene root, e.g. "textures/wood-oak.png" */
  path: string;
  /** Native pixel width (px) */
  widthPx: number;
  /** Native pixel height (px) */
  heightPx: number;
  /** Physical width in cm */
  widthCm: number;
  /** Physical height in cm */
  heightCm: number;
  /** Scale factor (1.0 = native) */
  scale: number;
  /** UV offset U */
  offsetU: number;
  /** UV offset V */
  offsetV: number;
  /** Rotation in radians */
  rotation: number;
  /** "repeat" | "clamp" */
  wrap: "repeat" | "clamp";
  /** 0=fitToArea 1=stretch 2=tile */
  fittingArea: 0 | 1 | 2;
}

// ── Material ────────────────────────────────────────────────────

export interface MaterialDef {
  id: string;
  /** Diffuse colour (sRGB uint32) */
  color: number;
  /** Optional texture override */
  textureId?: string;
  /** 0-1, 0 = matte, 1 = mirror-like */
  shininess: number;
  /** 0-1 opacity, 1 = fully opaque */
  opacity: number;
  /** "lambert" | "standard" (PBR) */
  model: "lambert" | "standard";
}

// ── Geometry primitives ─────────────────────────────────────────

export interface BoxPrimitive {
  type: "box";
  /** Centre position [x, y, z] in cm */
  position: [number, number, number];
  /** Full size [w, h, d] in cm */
  size: [number, number, number];
  /** Euler angles [rx, ry, rz] in radians */
  rotation: [number, number, number];
  materialId: string;
}

export interface PolygonPrimitive {
  type: "polygon";
  /** Vertices [[x, z], ...] in cm, Y is the floor plane */
  vertices: [number, number][];
  /** Floor Y level in cm */
  y: number;
  /** Extrusion height (walls) or 0 for flat fill */
  height: number;
  materialId: string;
}

export interface ExtrudePolygonPrimitive {
  type: "extrudePolygon";
  /** Outline points [[x, z], ...] */
  outline: [number, number][];
  /** Inner holes (windows/doors) as index lists */
  holes?: [number, number][][];
  y: number;
  height: number;
  materialId: string;
}

export type Primitive =
  | BoxPrimitive
  | PolygonPrimitive
  | ExtrudePolygonPrimitive;

// ── Scene object ────────────────────────────────────────────────

export interface SceneObject {
  id: string;
  name: string;
  primitives: Primitive[];
  /** Visibility per view type */
  visible: { plan: boolean; threeD: boolean; luxcore: boolean };
}

// ── Camera ──────────────────────────────────────────────────────

export interface CameraDef {
  position: [number, number, number]; // cm
  yaw: number; // radians
  pitch: number;
  fov: number; // degrees vertical
  /** "perspective" | "parallel" */
  projection: "perspective" | "parallel";
}

// ── Light ───────────────────────────────────────────────────────

export interface LightDef {
  id: string;
  /** "directional" | "point" */
  type: "directional" | "point";
  direction?: [number, number, number];
  position?: [number, number, number];
  /** 0-1 intensity */
  intensity: number;
  /** sRGB uint32 */
  color: number;
}

// ── Scene folder ────────────────────────────────────────────────

export interface RenderableScene {
  /** Scene metadata */
  version: 1;
  name: string;

  /** Textures referenced by materials */
  textures: TextureDef[];

  /** Materials used by primitives */
  materials: MaterialDef[];

  /** All renderable objects */
  objects: SceneObject[];

  /** Camera definition */
  camera: CameraDef;

  /** Scene lights */
  lights: LightDef[];

  /** Background colour (sRGB uint32) */
  backgroundColor: number;
}
