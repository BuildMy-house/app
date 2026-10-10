import type { TemplateDef } from '../dsl'

/** 12 x 14 ft (366 x 427 cm) interior. */
export const livingRoom: TemplateDef = {
  id: '12x14-living-room',
  name: '12x14 Living Room Layout',
  category: 'Single rooms',
  description:
    'A 12 by 14 ft living room with a sofa under a picture window, a TV wall opposite, a coffee table on a rug, and a clear walking path from the entry door.',
  features: ['Sofa + TV seating group', 'Picture window', 'Clear 90 cm entry path'],
  rooms: [{ id: 'living', name: 'Living room', rect: [0, 0, 386, 447], floor: 'wood-oak' }],
  openings: [
    { room: 'living', side: 'n', at: 'center', style: 'picture', width: 200 },
    { room: 'living', side: 'e', at: 340, style: 'front' },
  ],
  furniture: [
    { room: 'living', item: 'rug', x: 'c', y: 215, w: 240, d: 170 },
    { room: 'living', item: 'sofa', wall: 'n', at: 'center' },
    { room: 'living', item: 'sideTable', wall: 'n', at: 41 },
    { room: 'living', item: 'coffeeTable', x: 'c', y: 215 },
    { room: 'living', item: 'armchair', wall: 'w', at: 250 },
    { room: 'living', item: 'floorLamp', wall: 'w', at: 340, gap: 0 },
    { room: 'living', item: 'tvStand', wall: 's', at: 'center' },
    { room: 'living', item: 'tv', wall: 's', at: 'center', gap: 16, elev: 52 },
    { room: 'living', item: 'bookcase', wall: 'e', at: 'start' },
    { room: 'living', item: 'plant', wall: 'w', at: 'end' },
  ],
}
