import { run, type TemplateDef } from '../dsl'

/** 7.8 x 2.6 m (about 26 x 8.5 ft) tiny house on a single level. */
export const tinyHouse: TemplateDef = {
  id: 'tiny-house',
  name: 'Tiny House Floor Plan (26 ft)',
  category: 'Small spaces',
  description:
    'An 18 m2 (about 190 sq ft) one-level tiny house: a bedroom at one end, a living room with kitchen run in the middle, and a compact bathroom with shower at the other end.',
  features: ['Full-size bed', 'Kitchen run with range and fridge', 'Compact shower bath', 'Fits a 26 ft trailer footprint'],
  rooms: [
    { id: 'bed', name: 'Bedroom', rect: [0, 0, 300, 260], floor: 'wood-pine', kind: 'bedroom' },
    { id: 'living', name: 'Living & kitchen', rect: [300, 0, 600, 260], floor: 'wood-pine' },
    { id: 'bath', name: 'Bath', rect: [600, 0, 780, 260], floor: 'tile-floor', kind: 'bath' },
  ],
  openings: [
    { room: 'bed', side: 'n', at: 150, style: 'window' },
    { room: 'bed', side: 'w', at: 130, style: 'small' },
    { room: 'living', side: 'w', at: 130, style: 'door' },
    { room: 'living', side: 'e', at: 130, style: 'bathDoor' },
    { room: 'living', side: 's', at: 60, style: 'front' },
    { room: 'living', side: 'n', at: 120, style: 'window' },
    { room: 'living', side: 's', at: 200, style: 'window' },
    { room: 'bath', side: 'n', at: 100, style: 'high', width: 60 },
  ],
  furniture: [
    { room: 'bed', item: 'bedQueen', wall: 'w', at: 'center' },
    { room: 'bed', item: 'nightstand', wall: 'n', at: 'start' },
    { room: 'bed', item: 'closet', wall: 's', at: 'end', w: 70 },
    { room: 'living', item: 'fridge', wall: 'n', at: 'start' },
    ...run('living', 'n', 76, ['sink', 'range']),
    { room: 'living', item: 'loveseat', wall: 's', at: 'end' },
    { room: 'living', item: 'diningTableSq', name: 'Fold-down table', x: 175, y: 125, w: 90, d: 90 },
    { room: 'living', item: 'shelf', wall: 'e', at: 'start', w: 70 },
    { room: 'living', item: 'rug', x: 175, y: 125, w: 180, d: 120 },
    { room: 'bath', item: 'toilet', wall: 'n', at: 40 },
    { room: 'bath', item: 'vanity', wall: 'n', at: 100 },
    { room: 'bath', item: 'shower', wall: 'e', at: 'end' },
  ],
}
