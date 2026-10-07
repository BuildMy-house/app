import { run, type TemplateDef } from '../dsl'

/** 7.0 x 4.6 m cabin (about 32 m2 / 345 sq ft). */
export const smallCabin: TemplateDef = {
  id: 'small-cabin',
  name: 'Small Cabin Floor Plan with Bunk Room',
  category: 'Small homes',
  description:
    'A 29 m2 (315 sq ft) weekend cabin: a great room with kitchen, dining table and sofa, a bunk room with two twin beds and a closet, and a compact bath with shower.',
  features: ['Great room with kitchen and dining', 'Bunk room with two twin beds', 'Compact bath with shower', 'Reading chair and bookcase'],
  rooms: [
    { id: 'great', name: 'Great room', rect: [0, 0, 480, 460], floor: 'wood-pine' },
    { id: 'bunk', name: 'Bunk room', rect: [480, 0, 700, 280], floor: 'wood-pine', kind: 'bedroom' },
    { id: 'bath', name: 'Bath', rect: [480, 280, 700, 460], floor: 'tile-floor', kind: 'bath' },
  ],
  openings: [
    { room: 'great', side: 'n', at: 330, style: 'front' },
    { room: 'great', side: 'n', at: 150, style: 'window' },
    { room: 'great', side: 'w', at: 260, style: 'window', width: 90 },
    { room: 'great', side: 's', at: 400, style: 'window' },
    { room: 'bunk', side: 'w', at: 240, style: 'door' },
    { room: 'bunk', side: 'n', at: 110, style: 'small' },
    { room: 'bunk', side: 'e', at: 130, style: 'small' },
    { room: 'bath', side: 'w', at: 60, style: 'bathDoor' },
    { room: 'bath', side: 's', at: 100, style: 'high', width: 60 },
  ],
  furniture: [
    ...run('great', 'w', 0, ['fridge', 'base', 'range', 'sink']),
    { room: 'great', item: 'diningTable', x: 170, y: 90 },
    { room: 'great', item: 'chair', x: 135, y: 22, face: 's' },
    { room: 'great', item: 'chair', x: 215, y: 22, face: 's' },
    { room: 'great', item: 'chair', x: 135, y: 158, face: 'n' },
    { room: 'great', item: 'chair', x: 215, y: 158, face: 'n' },
    { room: 'great', item: 'rug', x: 250, y: 250 },
    { room: 'great', item: 'coffeeTable', x: 250, y: 250 },
    { room: 'great', item: 'sofa', wall: 's', at: 250 },
    { room: 'great', item: 'bookcase', wall: 's', at: 'start' },
    { room: 'great', item: 'armchair', wall: 'e', at: 100 },
    { room: 'great', item: 'floorLamp', wall: 'e', at: 'end', gap: 0 },
    { room: 'bunk', item: 'bedTwin', wall: 'n', at: 'start' },
    { room: 'bunk', item: 'bedTwin', wall: 'n', at: 'end' },
    { room: 'bunk', item: 'closet', wall: 's', at: 'end' },
    { room: 'bath', item: 'shower', wall: 'e', at: 'start' },
    { room: 'bath', item: 'toilet', wall: 's', at: 100 },
    { room: 'bath', item: 'vanity', wall: 'w', at: 'end' },
  ],
}
