/**
 * Furniture + opening vocabulary for template authoring. Dimensions are cm and
 * are copied into each generated plan, so a template keeps its layout even if a
 * catalog model is later re-ingested. `catalog` items borrow the 3D model from
 * the live catalog; items without one render as colored boxes (the catalog has
 * no beds, toilets, tubs, fridges or dining tables yet).
 */

export interface Item {
  name: string
  w: number
  d: number
  h: number
  elev?: number
  color?: number
  catalog?: string
}

const SH = 'sh3d-full#'

export const ITEMS = {
  // Living
  sofa: { name: 'Sofa', w: 234, d: 79, h: 79, catalog: `${SH}PeterSmolik#sofa1` },
  sofa2: { name: 'Sofa', w: 185, d: 74, h: 84, catalog: `${SH}PeterSmolik#sofa4` },
  loveseat: { name: 'Loveseat', w: 156, d: 71, h: 75, catalog: `${SH}Pencilart#couchPoofyPillows` },
  armchair: { name: 'Armchair', w: 85, d: 77, h: 75, catalog: `${SH}Pencilart#singleChair` },
  tvStand: { name: 'TV stand', w: 140, d: 40, h: 52, catalog: `${SH}Dingenskirchen#pinewoodRackLowHeight` },
  tv: { name: 'TV', w: 110, d: 8, h: 64, elev: 60, color: 0x1c1e22 },
  bookcase: { name: 'Bookcase', w: 90, d: 30, h: 227, catalog: `${SH}Dingenskirchen#pinewoodRackFullHeight` },
  shelf: { name: 'Shelving unit', w: 90, d: 30, h: 143, catalog: `${SH}Dingenskirchen#pinewoodRackMediumHeight` },
  rug: { name: 'Rug', w: 200, d: 140, h: 1, catalog: `${SH}Puybaret#carpet` },
  coffeeTable: { name: 'Coffee table', w: 110, d: 60, h: 42, color: 0x8a6a4b },
  sideTable: { name: 'Side table', w: 45, d: 45, h: 55, color: 0x8a6a4b },
  plant: { name: 'Plant', w: 55, d: 55, h: 85, catalog: `${SH}PeterSmolik#potplant2` },
  floorLamp: { name: 'Floor lamp', w: 30, d: 30, h: 160, color: 0xd9d2c0 },
  console: { name: 'Console table', w: 117, d: 45, h: 88, catalog: `${SH}PeterSmolik#hallTable` },
  bench: { name: 'Bench', w: 100, d: 38, h: 45, color: 0x8a6a4b },
  // Bedroom
  bedKing: { name: 'King bed', w: 193, d: 203, h: 50, color: 0xa9b8c9 },
  bedQueen: { name: 'Queen bed', w: 160, d: 203, h: 50, color: 0xa9b8c9 },
  bedDouble: { name: 'Double bed', w: 140, d: 190, h: 48, color: 0xb9c4a8 },
  bedTwin: { name: 'Twin bed', w: 97, d: 190, h: 45, color: 0xc9b8a9 },
  crib: { name: 'Crib', w: 70, d: 132, h: 90, color: 0xe8e0d0 },
  nightstand: { name: 'Nightstand', w: 45, d: 40, h: 55, color: 0x8a6a4b },
  dresser: { name: 'Dresser', w: 117, d: 50, h: 88, catalog: `${SH}PeterSmolik#hallTable` },
  wardrobe: { name: 'Wardrobe', w: 180, d: 60, h: 221, catalog: `${SH}Bettinelli#armoireLotus` },
  closet: { name: 'Closet', w: 120, d: 60, h: 220, color: 0xd8d0c0 },
  // Dining
  diningTable: { name: 'Dining table', w: 160, d: 90, h: 75, color: 0x8b6b4a },
  diningTable6: { name: 'Dining table', w: 200, d: 95, h: 75, color: 0x8b6b4a },
  diningTableSq: { name: 'Dining table', w: 110, d: 110, h: 75, color: 0x8b6b4a },
  chair: { name: 'Dining chair', w: 43, d: 42, h: 87, catalog: `${SH}Pencilart#latticeChair` },
  stool: { name: 'Bar stool', w: 38, d: 38, h: 70, color: 0x6b5a48 },
  sideboard: { name: 'Sideboard', w: 150, d: 45, h: 85, color: 0x8a6a4b },
  // Kitchen (counter depth 60-64)
  base: { name: 'Base cabinet', w: 52, d: 64, h: 86, catalog: `${SH}Pencilart#1DoorLowerCabinet` },
  base2: { name: 'Base cabinet', w: 96, d: 64, h: 86, catalog: `${SH}Pencilart#2DoorLowerCabinet` },
  drawers: { name: 'Drawer cabinet', w: 53, d: 64, h: 86, catalog: `${SH}Pencilart#3DrawerCabinet` },
  sink: { name: 'Sink cabinet', w: 91, d: 64, h: 111, catalog: `${SH}Pencilart#kitchenSinkWithMarble` },
  range: { name: 'Range', w: 76, d: 64, h: 92, catalog: `${SH}Pencilart#stove1` },
  upper: { name: 'Wall cabinet', w: 45, d: 39, h: 71, elev: 160, catalog: `${SH}Pencilart#1DoorUpperCabinet` },
  upper2: { name: 'Wall cabinet', w: 96, d: 39, h: 71, elev: 160, catalog: `${SH}Pencilart#2DoorUpperCabinet` },
  pantry: { name: 'Pantry cabinet', w: 70, d: 64, h: 200, catalog: `${SH}Pencilart#pantry` },
  fridge: { name: 'Refrigerator', w: 76, d: 72, h: 180, color: 0xd5d9dd },
  dishwasher: { name: 'Dishwasher', w: 60, d: 62, h: 86, color: 0xc9ced3 },
  island: { name: 'Kitchen island', w: 180, d: 96, h: 90, catalog: `${SH}Pencilart#kitchenIsland` },
  barCounter: { name: 'Bar counter', w: 121, d: 45, h: 108, catalog: `${SH}Bettinelli#barCusisine` },
  // Bath / laundry
  toilet: { name: 'Toilet', w: 38, d: 68, h: 40, color: 0xf2f2f2 },
  tub: { name: 'Bathtub', w: 170, d: 75, h: 55, color: 0xf2f2f2 },
  shower: { name: 'Shower tray', w: 90, d: 90, h: 8, color: 0xe4e8ec },
  vanity: { name: 'Vanity', w: 60, d: 50, h: 85, color: 0xe9e4da },
  vanity2: { name: 'Double vanity', w: 120, d: 52, h: 85, color: 0xe9e4da },
  washer: { name: 'Washer', w: 60, d: 64, h: 85, color: 0xe6e9ec },
  dryer: { name: 'Dryer', w: 60, d: 64, h: 85, color: 0xe6e9ec },
  // Office
  desk: { name: 'Desk', w: 140, d: 70, h: 75, color: 0xb08d6a },
  deskSmall: { name: 'Desk', w: 120, d: 60, h: 75, color: 0xb08d6a },
  deskL: { name: 'Corner desk', w: 160, d: 70, h: 75, color: 0xb08d6a },
  officeChair: { name: 'Office chair', w: 63, d: 60, h: 87, catalog: `${SH}PeterSmolik#officeChair` },
  filing: { name: 'Filing cabinet', w: 45, d: 60, h: 70, color: 0xaeb3b8 },
  conferenceTable: { name: 'Meeting table', w: 220, d: 100, h: 75, color: 0x8b6b4a },
  // Outdoor
  grill: { name: 'Grill', w: 92, d: 50, h: 89, catalog: `${SH}Pencilart#grillNgauge` },
  bike: { name: 'Bike rack', w: 180, d: 40, h: 100, color: 0x6b7075 },
  workbench: { name: 'Workbench', w: 180, d: 60, h: 90, color: 0x8a6a4b },
  waterHeater: { name: 'Water heater', w: 60, d: 60, h: 150, color: 0xd5d9dd },
} satisfies Record<string, Item>

export type ItemId = keyof typeof ITEMS

export interface OpeningStyle {
  name: string
  kind: 'door' | 'window'
  catalog: string
  /** Default opening width; the model is stretched to the requested width. */
  w: number
  d: number
  h: number
  elev: number
}

export const OPENINGS = {
  door: { name: 'Interior door', kind: 'door', catalog: `${SH}PeterSmolik#door1`, w: 82, d: 18, h: 205, elev: 0 },
  bathDoor: { name: 'Bathroom door', kind: 'door', catalog: `${SH}PeterSmolik#door1`, w: 72, d: 18, h: 205, elev: 0 },
  front: { name: 'Front door', kind: 'door', catalog: `${SH}PencilArt#fancyFrontDoor`, w: 100, d: 24, h: 205, elev: 0 },
  patio: { name: 'Patio door', kind: 'door', catalog: `${SH}Pencilart#patioDoor`, w: 160, d: 18, h: 210, elev: 0 },
  slider: { name: 'Sliding door', kind: 'door', catalog: `${SH}OlaKristianHoff#sliderPocketDoor`, w: 90, d: 12, h: 210, elev: 0 },
  garage: { name: 'Garage door', kind: 'door', catalog: `${SH}Pencilart#garageDoor2`, w: 240, d: 15, h: 220, elev: 0 },
  double: { name: 'Double glass door', kind: 'door', catalog: `${SH}Siath#emergencyGlassDoubleDoor`, w: 180, d: 28, h: 210, elev: 0 },
  window: { name: 'Window', kind: 'window', catalog: `${SH}Pencilart#fancyWindow`, w: 120, d: 8, h: 128, elev: 91 },
  small: { name: 'Window', kind: 'window', catalog: `${SH}Pencilart#fancyWindow`, w: 80, d: 8, h: 100, elev: 110 },
  high: { name: 'High window', kind: 'window', catalog: `${SH}Pencilart#newWindowDk`, w: 90, d: 6, h: 60, elev: 150 },
  picture: { name: 'Picture window', kind: 'window', catalog: `${SH}Pencilart#fancyWindow`, w: 200, d: 8, h: 140, elev: 80 },
} satisfies Record<string, OpeningStyle>

export type OpeningId = keyof typeof OPENINGS
