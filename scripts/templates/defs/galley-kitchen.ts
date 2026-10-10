import { run, type TemplateDef } from '../dsl'

/** 4.0 x 2.3 m galley kitchen (inner size). */
export const galleyKitchen: TemplateDef = {
  id: 'galley-kitchen',
  name: 'Galley Kitchen Layout',
  category: 'Single rooms',
  description:
    'A galley kitchen of about 9 m2 (99 sq ft): two parallel runs with a 100 cm aisle, a sink under the window, a range and refrigerator opposite, and wall cabinets above.',
  features: ['Two parallel runs', '100 cm aisle', 'Sink under the window', 'Wall cabinets'],
  rooms: [{ id: 'galley', name: 'Galley kitchen', rect: [0, 0, 420, 250], floor: 'tile-floor' }],
  openings: [
    { room: 'galley', side: 'w', at: 125, style: 'door' },
    { room: 'galley', side: 'e', at: 125, style: 'door' },
    { room: 'galley', side: 's', at: 108, style: 'small' },
  ],
  furniture: [
    ...run('galley', 'n', 0, ['fridge', 'base', 'range', 'base', 'drawers']),
    ...run('galley', 's', 52, ['sink', 'dishwasher', 'base', 'drawers', 'base']),
    { room: 'galley', item: 'upper', wall: 'n', at: 150 },
    { room: 'galley', item: 'upper', wall: 'n', at: 195 },
    { room: 'galley', item: 'upper', wall: 'n', at: 300 },
    { room: 'galley', item: 'upper', wall: 's', at: 150 },
    { room: 'galley', item: 'upper', wall: 's', at: 260 },
  ],
}
