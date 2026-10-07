import { run, type TemplateDef } from '../dsl'

/** 6.0 x 5.0 m detached accessory dwelling unit (about 30 m2 / 320 sq ft). */
export const backyardAduCottage: TemplateDef = {
  id: 'backyard-adu-cottage',
  name: 'Backyard ADU Cottage Floor Plan',
  category: 'Small homes',
  description:
    'A 27 m2 (290 sq ft) detached backyard cottage or ADU with a combined living room and kitchen, a double-bed bedroom with closet, and a full bath with tub.',
  features: ['Living, kitchen and dining in one room', 'Separate bedroom with closet', 'Full bath with tub', 'Front door to the garden path'],
  rooms: [
    { id: 'living', name: 'Living & kitchen', rect: [0, 0, 380, 500], floor: 'wood-oak' },
    { id: 'bed', name: 'Bedroom', rect: [380, 0, 600, 300], floor: 'wood-oak', kind: 'bedroom' },
    { id: 'bath', name: 'Bath', rect: [380, 300, 600, 500], floor: 'tile-floor', kind: 'bath' },
  ],
  openings: [
    { room: 'living', side: 'n', at: 260, style: 'window', width: 90 },
    { room: 'living', side: 'w', at: 120, style: 'window' },
    { room: 'living', side: 's', at: 190, style: 'front' },
    { room: 'living', side: 's', at: 320, style: 'small' },
    { room: 'bed', side: 'w', at: 230, style: 'door' },
    { room: 'bed', side: 'n', at: 110, style: 'window' },
    { room: 'bed', side: 'e', at: 150, style: 'small' },
    { room: 'bath', side: 'w', at: 40, style: 'bathDoor' },
    { room: 'bath', side: 's', at: 170, style: 'high', width: 60 },
  ],
  furniture: [
    ...run('living', 'n', 0, ['fridge', 'base', 'range', 'sink']),
    { room: 'living', item: 'tvStand', wall: 'w', at: 300 },
    { room: 'living', item: 'tv', wall: 'w', at: 300, gap: 16, elev: 52 },
    { room: 'living', item: 'coffeeTable', x: 130, y: 300, face: 'w' },
    { room: 'living', item: 'loveseat', x: 215, y: 300, face: 'w' },
    { room: 'living', item: 'diningTableSq', x: 230, y: 140 },
    { room: 'living', item: 'chair', x: 154, y: 140, face: 'e' },
    { room: 'living', item: 'chair', x: 306, y: 140, face: 'w' },
    { room: 'living', item: 'plant', wall: 's', at: 'end' },
    { room: 'bed', item: 'bedDouble', wall: 'e', at: 'start' },
    { room: 'bed', item: 'nightstand', wall: 'e', at: 172 },
    { room: 'bed', item: 'closet', wall: 's', at: 'end' },
    { room: 'bath', item: 'tub', wall: 'e', at: 'start' },
    { room: 'bath', item: 'toilet', wall: 's', at: 90 },
    { room: 'bath', item: 'vanity', wall: 'w', at: 150 },
  ],
}
