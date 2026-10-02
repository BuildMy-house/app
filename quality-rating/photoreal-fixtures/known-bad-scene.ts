/**
 * Shared fixture data for photoreal render tests (aqs-5).
 *
 * Single source of truth for scene data consumed by:
 * - scenes.spec.ts (Playwright, builds the scene via the store API)
 * - the MCP stdio driver (KNOWN_BAD_PLAN -> build_house) for LuxCore renders
 */

export interface KnownBadItem {
  catalogId: string;
  x: number;
  y: number;
}

export const KNOWN_BAD_CATALOG_IDS: string[] = [
  'sh3d-full#Siath#emergencyGlassDoubleDoor',
  'sh3d-full#Pencilart#accordionFoldDoors',
  'sh3d-full#Pencilart#glassDoorsOpened',
  'sh3d-full#OlaKristianHoff#bathroom_fan',
  'sh3d-full#Mchnz#craftsmanDoorClosed',
  'sh3d-full#OlaKristianHoff#sliderPocketDoor',
  'sh3d-full#OlaKristianHoff#vent_round',
  'sh3d-full#OlaKristianHoff#window_2x3_frame_sill',
  'sh3d-full#OlaKristianHoff#window_deep',
  'sh3d-full#PeterSmolik#futon',
  'sh3d-full#Toomy#pileMagazines',
];

/** Display names from assets/catalog/catalog.json (search terms for placeFromCatalog). */
export const KNOWN_BAD_SEARCH_NAMES: string[] = [
  'Emergency glass double door',
  'Accordion fold doors',
  'Opened quadruple glass doors',
  'Fan',
  'Craftsman door',
  'Slider pocket door',
  'Round vent',
  'Window 2x3',
  'Deep window',
  'Futon',
  'Magazines pile',
];

export const KNOWN_BAD_POSITIONS: Array<{ x: number; y: number }> = [
  { x: -140, y: -140 },
  { x: -60, y: -140 },
  { x: 20, y: -140 },
  { x: 100, y: -140 },
  { x: -140, y: -60 },
  { x: -60, y: -60 },
  { x: 20, y: -60 },
  { x: 100, y: -60 },
  { x: -140, y: 20 },
  { x: -60, y: 20 },
  { x: 20, y: 20 },
];

export const ROOM = {
  points: [
    [-200, -200],
    [200, -200],
    [200, 200],
    [-200, 200],
  ],
};

/** Standardized camera + lighting preset for all photoreal fixtures.
 * Wireable (verified luxcore/bridge.py):
 * - hdri 'studio' -> home.environment.hdriPreset='studio' (bridge.py L341, photo_studio_01_1k.hdr)
 * - azimuth/elevation -> home.cameras.observer yawDeg/pitchDeg (bridge.py L57-69)
 * - fovDeg 60 is bridge default.
 */
export const STANDARD_CAMERA_PRESET = {
  hdri: 'studio',
  azimuth: 45,
  elevation: 30,
  fovDeg: 60,
  heightCm: 250,
} as const;

export function observerCamera(preset = STANDARD_CAMERA_PRESET) {
  return {
    x: 0,
    y: 0,
    z: preset.heightCm,
    yawDeg: preset.azimuth,
    pitchDeg: preset.elevation,
    fovDeg: preset.fovDeg,
  };
}

export function homeEnvironment() {
  return { hdriPreset: STANDARD_CAMERA_PRESET.hdri };
}

export function knownBadFurniture(): Array<Record<string, unknown>> {
  return KNOWN_BAD_CATALOG_IDS.map((catalogId, i) => ({
    name: catalogId.split('#').pop() || catalogId,
    key: `known-bad-${i + 1}`,
    catalogId,
    x: KNOWN_BAD_POSITIONS[i].x,
    y: KNOWN_BAD_POSITIONS[i].y,
    angleDeg: 0,
    width: 80,
    depth: 80,
    height: 150,
    elevation: 0,
    doorOrWindow: false,
  }));
}

/** MCP build_house plan for the known-bad scene. */
export const KNOWN_BAD_PLAN = {
  name: 'aqs5-known-bad-scene',
  rooms: [{ key: 'bad-room', points: ROOM.points, name: 'Known Bad' }],
  auto_walls: true,
  furniture: knownBadFurniture(),
  camera: observerCamera(),
  environment: homeEnvironment(),
  to_json() {
    return {
      name: this.name,
      rooms: this.rooms,
      auto_walls: this.auto_walls,
      furniture: this.furniture,
      camera: this.camera,
      environment: this.environment,
    };
  },
};
