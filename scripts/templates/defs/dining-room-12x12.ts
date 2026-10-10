import type { TemplateDef } from '../dsl'

/** 12 x 12 ft (366 x 366 cm) interior. */
export const diningRoom: TemplateDef = {
  id: 'dining-room-12x12',
  name: '12x12 Dining Room Layout',
  category: 'Single rooms',
  description:
    'A 12 by 12 ft formal dining room seating six around a rectangular table, with a sideboard, a display bookcase and generous chair-pull-out clearance on all sides.',
  features: ['Seats six', '70 cm chair clearance all round', 'Sideboard for serving', 'Display bookcase'],
  rooms: [{ id: 'dining', name: 'Dining room', rect: [0, 0, 386, 386], floor: 'wood-oak' }],
  openings: [
    { room: 'dining', side: 'n', at: 193, style: 'picture', width: 200 },
    { room: 'dining', side: 'e', at: 193, style: 'window' },
    { room: 'dining', side: 'w', at: 280, style: 'door' },
  ],
  furniture: [
    { room: 'dining', item: 'rug', x: 183, y: 160, w: 280, d: 200 },
    { room: 'dining', item: 'diningTable6', x: 183, y: 160 },
    { room: 'dining', item: 'chair', x: 128, y: 91, face: 's' },
    { room: 'dining', item: 'chair', x: 183, y: 91, face: 's' },
    { room: 'dining', item: 'chair', x: 238, y: 91, face: 's' },
    { room: 'dining', item: 'chair', x: 128, y: 229, face: 'n' },
    { room: 'dining', item: 'chair', x: 183, y: 229, face: 'n' },
    { room: 'dining', item: 'chair', x: 238, y: 229, face: 'n' },
    { room: 'dining', item: 'sideboard', wall: 's', at: 'center' },
    { room: 'dining', item: 'bookcase', wall: 'w', at: 'start' },
    { room: 'dining', item: 'plant', wall: 's', at: 'end' },
    { room: 'dining', item: 'floorLamp', wall: 'e', at: 'start' },
  ],
}
