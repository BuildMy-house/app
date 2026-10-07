import { run, type TemplateDef } from '../dsl'

/** 5 x 4.4 m (about 16 x 14 ft) L-shaped kitchen with an eat-in dining area. */
export const lShapedKitchenDiner: TemplateDef = {
  id: 'l-shaped-kitchen-diner',
  name: 'L-Shaped Kitchen and Diner Layout',
  category: 'Single rooms',
  description:
    'An L-shaped kitchen along two walls with a six-person dining area, a pantry cabinet and a sideboard. The classic eat-in kitchen for a 16 by 14 ft room.',
  features: ['L-shaped work triangle', 'Pantry cabinet', 'Dining for four', 'Sideboard storage'],
  rooms: [{ id: 'kitchen', name: 'Kitchen & diner', rect: [0, 0, 500, 440], floor: 'tile-floor' }],
  openings: [
    { room: 'kitchen', side: 'n', at: 230, style: 'window', width: 120 },
    { room: 'kitchen', side: 'e', at: 220, style: 'window' },
    { room: 'kitchen', side: 's', at: 420, style: 'door' },
  ],
  furniture: [
    ...run('kitchen', 'n', 0, ['fridge', 'base', 'range', 'base', 'sink', 'dishwasher']),
    ...run('kitchen', 'w', 74, ['base', 'drawers', 'pantry']),
    { room: 'kitchen', item: 'diningTable', x: 280, y: 270 },
    { room: 'kitchen', item: 'chair', x: 240, y: 204, face: 's' },
    { room: 'kitchen', item: 'chair', x: 320, y: 204, face: 's' },
    { room: 'kitchen', item: 'chair', x: 240, y: 336, face: 'n' },
    { room: 'kitchen', item: 'chair', x: 320, y: 336, face: 'n' },
    { room: 'kitchen', item: 'sideboard', wall: 's', at: 'start' },
    { room: 'kitchen', item: 'plant', wall: 'e', at: 100 },
  ],
}
