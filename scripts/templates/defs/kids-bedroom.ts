import type { TemplateDef } from '../dsl'

/** 3.2 x 3.6 m shared kids bedroom. */
export const kidsBedroom: TemplateDef = {
  id: 'kids-bedroom',
  name: 'Shared Kids Bedroom Layout',
  category: 'Single rooms',
  description:
    'A shared kids bedroom of about 11.5 m2 (124 sq ft) with two twin beds, a nightstand between them, a homework desk, a bookcase and a closet along the short wall.',
  features: ['Two twin beds', 'Homework desk by the window', 'Bookcase + closet storage', 'Open floor for play'],
  rooms: [{ id: 'kids', name: 'Kids bedroom', rect: [0, 0, 340, 380], floor: 'carpet', kind: 'bedroom' }],
  openings: [
    { room: 'kids', side: 'n', at: 170, style: 'window' },
    { room: 'kids', side: 'w', at: 150, style: 'small' },
    { room: 'kids', side: 's', at: 150, style: 'door' },
  ],
  furniture: [
    { room: 'kids', item: 'bedTwin', wall: 'n', at: 'start' },
    { room: 'kids', item: 'bedTwin', wall: 'n', at: 'end' },
    { room: 'kids', item: 'nightstand', wall: 'n', at: 160 },
    { room: 'kids', item: 'deskSmall', wall: 'e', at: 250 },
    { room: 'kids', item: 'officeChair', x: 215, y: 250, face: 'e' },
    { room: 'kids', item: 'bookcase', wall: 'w', at: 'end' },
    { room: 'kids', item: 'closet', wall: 's', at: 'end', d: 50 },
    { room: 'kids', item: 'rug', x: 160, y: 200, w: 200, d: 140 },
  ],
}
