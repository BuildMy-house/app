import { run, type TemplateDef } from '../dsl'

/** 8.0 x 5.2 m open-plan great room. */
export const openPlanLivingKitchenDining: TemplateDef = {
  id: 'open-plan-living-kitchen-dining',
  name: 'Open-Plan Living, Kitchen and Dining Layout',
  category: 'Single rooms',
  description:
    'A 39 m2 (about 420 sq ft) open-plan great room with a kitchen and island on one side, a six-seat dining table by the patio door, and a sofa-and-TV living zone.',
  features: ['Kitchen with island and stools', 'Dining for six by the patio door', 'Living zone with TV wall', 'Patio door to the yard'],
  rooms: [{ id: 'great', name: 'Living, kitchen & dining', rect: [0, 0, 800, 520], floor: 'wood-oak' }],
  openings: [
    { room: 'great', side: 'n', at: 260, style: 'window', width: 140 },
    { room: 'great', side: 'n', at: 530, style: 'picture', width: 200 },
    { room: 'great', side: 'e', at: 130, style: 'patio' },
    { room: 'great', side: 'w', at: 400, style: 'front' },
    { room: 'great', side: 'w', at: 150, style: 'window' },
  ],
  furniture: [
    ...run('great', 'n', 0, ['fridge', 'base', 'range', 'sink', 'dishwasher']),
    { room: 'great', item: 'island', x: 190, y: 175 },
    { room: 'great', item: 'stool', x: 150, y: 250 },
    { room: 'great', item: 'stool', x: 190, y: 250 },
    { room: 'great', item: 'stool', x: 230, y: 250 },
    { room: 'great', item: 'diningTable', x: 520, y: 110 },
    { room: 'great', item: 'chair', x: 485, y: 44, face: 's' },
    { room: 'great', item: 'chair', x: 555, y: 44, face: 's' },
    { room: 'great', item: 'chair', x: 485, y: 176, face: 'n' },
    { room: 'great', item: 'chair', x: 555, y: 176, face: 'n' },
    { room: 'great', item: 'rug', x: 560, y: 330, w: 300, d: 200 },
    { room: 'great', item: 'sofa', x: 560, y: 330 },
    { room: 'great', item: 'coffeeTable', x: 560, y: 400 },
    { room: 'great', item: 'tvStand', wall: 's', at: 560 },
    { room: 'great', item: 'tv', wall: 's', at: 560, gap: 16, elev: 52 },
    { room: 'great', item: 'armchair', wall: 'e', at: 360 },
    { room: 'great', item: 'bookcase', wall: 'e', at: 'end' },
    { room: 'great', item: 'floorLamp', x: 420, y: 330 },
    { room: 'great', item: 'sideboard', wall: 's', at: 'start' },
    { room: 'great', item: 'plant', wall: 's', at: 330 },
  ],
}
