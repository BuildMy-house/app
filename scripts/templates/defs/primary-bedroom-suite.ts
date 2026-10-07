import type { TemplateDef } from '../dsl'

/** ~48 m2 primary suite: bedroom, ensuite bath and walk-in closet. */
export const primaryBedroomSuite: TemplateDef = {
  id: 'primary-bedroom-suite',
  name: 'Primary Bedroom Suite Layout',
  category: 'Single rooms',
  description:
    'A primary bedroom suite with a king bed, seating corner, en-suite bath with tub and shower, and a walk-in closet. About 30 m2 (330 sq ft) in total.',
  features: ['King bed with bench', 'Ensuite with tub and shower', 'Walk-in closet', 'Reading chair by the window'],
  rooms: [
    { id: 'bedroom', name: 'Bedroom', rect: [0, 0, 460, 440], floor: 'carpet', kind: 'bedroom' },
    { id: 'ensuite', name: 'Ensuite bath', rect: [460, 0, 760, 260], floor: 'tile-floor', kind: 'bath' },
    { id: 'closet', name: 'Walk-in closet', rect: [460, 260, 760, 440], floor: 'carpet' },
  ],
  openings: [
    { room: 'bedroom', side: 'n', at: 232, style: 'window' },
    { room: 'bedroom', side: 'w', at: 250, style: 'window' },
    { room: 'bedroom', side: 's', at: 380, style: 'front' },
    { room: 'ensuite', side: 'w', at: 130, style: 'bathDoor' },
    { room: 'ensuite', side: 'n', at: 150, style: 'high', width: 60 },
    { room: 'closet', side: 'w', at: 60, style: 'door' },
  ],
  furniture: [
    { room: 'bedroom', item: 'bedKing', wall: 'n', at: 222 },
    { room: 'bedroom', item: 'nightstand', wall: 'n', at: 103.5 },
    { room: 'bedroom', item: 'nightstand', wall: 'n', at: 340.5 },
    { room: 'bedroom', item: 'bench', x: 222, y: 245 },
    { room: 'bedroom', item: 'dresser', wall: 's', at: 222 },
    { room: 'bedroom', item: 'tv', wall: 's', at: 222, gap: 16, elev: 88 },
    { room: 'bedroom', item: 'armchair', wall: 'w', at: 320 },
    { room: 'bedroom', item: 'floorLamp', wall: 'w', at: 260 },
    { room: 'bedroom', item: 'plant', wall: 's', at: 'start' },
    { room: 'ensuite', item: 'tub', wall: 'n', at: 'end' },
    { room: 'ensuite', item: 'shower', wall: 'e', at: 'end' },
    { room: 'ensuite', item: 'toilet', wall: 's', at: 60 },
    { room: 'ensuite', item: 'vanity', wall: 's', at: 140 },
    { room: 'closet', item: 'wardrobe', wall: 'n', at: 'end' },
    { room: 'closet', item: 'wardrobe', wall: 's', at: 'end' },
    { room: 'closet', item: 'bench', x: 185, y: 82 },
  ],
}
