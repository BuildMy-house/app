import { run, type TemplateDef } from '../dsl'

/** ~36 m2 (390 sq ft) studio with a separate bath and entry. */
export const studioApartment: TemplateDef = {
  id: 'studio-apartment',
  name: 'Studio Apartment Floor Plan',
  category: 'Apartments',
  description:
    'A 400 sq ft studio apartment with a kitchenette, dining nook, sofa and TV zone, a bed along the far wall, a full bath and a coat-closet entry.',
  features: ['Kitchenette with full-size fridge', 'Separate sleeping zone', 'Entry with coat closet', 'Full bath with tub'],
  rooms: [
    { id: 'bath', name: 'Bath', rect: [0, 0, 220, 260], floor: 'tile-floor', kind: 'bath' },
    { id: 'entry', name: 'Entry', rect: [0, 260, 220, 560], floor: 'wood-pine' },
    { id: 'main', name: 'Studio', rect: [220, 0, 720, 560], floor: 'wood-pine' },
  ],
  openings: [
    { room: 'entry', side: 'w', at: 150, style: 'front' },
    { room: 'entry', side: 'e', at: 60, style: 'door' },
    { room: 'bath', side: 'e', at: 180, style: 'bathDoor' },
    { room: 'bath', side: 'n', at: 110, style: 'high', width: 60 },
    { room: 'main', side: 'n', at: 178, style: 'window' },
    { room: 'main', side: 'e', at: 410, style: 'small' },
    { room: 'main', side: 's', at: 250, style: 'picture', width: 160 },
  ],
  furniture: [
    ...run('main', 'n', 0, ['fridge', 'base', 'sink', 'range']),
    { room: 'main', item: 'diningTableSq', x: 175, y: 200 },
    { room: 'main', item: 'chair', x: 97, y: 200, face: 'e' },
    { room: 'main', item: 'chair', x: 253, y: 200, face: 'w' },
    { room: 'main', item: 'tvStand', wall: 'w', at: 430 },
    { room: 'main', item: 'tv', wall: 'w', at: 430, gap: 16, elev: 52 },
    { room: 'main', item: 'rug', x: 190, y: 400, w: 200, d: 160 },
    { room: 'main', item: 'loveseat', x: 175, y: 400, face: 'w' },
    { room: 'main', item: 'sideTable', x: 175, y: 505 },
    { room: 'main', item: 'bedQueen', wall: 'e', at: 400 },
    { room: 'main', item: 'nightstand', wall: 'e', at: 297.5 },
    { room: 'main', item: 'nightstand', wall: 'e', at: 502.5 },
    { room: 'main', item: 'plant', wall: 's', at: 330 },
    { room: 'bath', item: 'tub', wall: 'n', at: 'start' },
    { room: 'bath', item: 'toilet', wall: 's', at: 40 },
    { room: 'bath', item: 'vanity', wall: 'w', at: 130 },
    { room: 'entry', item: 'wardrobe', wall: 's', at: 'start' },
    { room: 'entry', item: 'bench', wall: 'n', at: 'start' },
  ],
}
