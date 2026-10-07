import type { TemplateDef } from '../dsl'

/** 10 x 12 ft (305 x 366 cm) interior. */
export const homeOffice: TemplateDef = {
  id: 'home-office-10x12',
  name: '10x12 Home Office Layout',
  category: 'Single rooms',
  description:
    'A 10 by 12 ft home office with an L-shaped desk facing the window, two bookcases, a filing cabinet, and a loveseat for reading or a video-call backdrop.',
  features: ['L-shaped desk facing the window', 'Two bookcases + shelf', 'Loveseat reading corner', 'Filing storage'],
  rooms: [{ id: 'office', name: 'Home office', rect: [0, 0, 325, 386], floor: 'wood-pine' }],
  openings: [
    { room: 'office', side: 'n', at: 162, style: 'window' },
    { room: 'office', side: 'w', at: 300, style: 'door' },
    { room: 'office', side: 'e', at: 160, style: 'small' },
  ],
  furniture: [
    { room: 'office', item: 'deskL', wall: 'n', at: 'center' },
    { room: 'office', item: 'officeChair', x: 152, y: 115, face: 'n' },
    { room: 'office', item: 'bookcase', wall: 'w', at: 'start' },
    { room: 'office', item: 'bookcase', wall: 'w', at: 145 },
    { room: 'office', item: 'filing', wall: 's', at: 150 },
    { room: 'office', item: 'loveseat', wall: 'e', at: 240 },
    { room: 'office', item: 'sideTable', wall: 'e', at: 342 },
    { room: 'office', item: 'floorLamp', wall: 'e', at: 'start' },
    { room: 'office', item: 'shelf', wall: 'e', at: 105 },
    { room: 'office', item: 'plant', wall: 's', at: 205 },
    { room: 'office', item: 'rug', x: 190, y: 250, w: 150, d: 100 },
  ],
}
