import type { TemplateDef } from '../dsl'

/** 5 x 8 ft (152 x 244 cm) interior. */
export const fullBathroom: TemplateDef = {
  id: 'full-bathroom-5x8',
  name: '5x8 Full Bathroom Layout',
  category: 'Single rooms',
  description:
    'The classic 5 by 8 ft full bathroom: bathtub along the long wall, toilet and vanity on the opposite side, and a linen shelf next to the door.',
  features: ['Bathtub along the long wall', 'Toilet on the short wall', 'Vanity with mirror wall', 'Linen shelf'],
  rooms: [{ id: 'bath', name: 'Bathroom', rect: [0, 0, 172, 264], floor: 'tile-floor', kind: 'bath' }],
  openings: [
    { room: 'bath', side: 's', at: 120, style: 'bathDoor' },
    { room: 'bath', side: 'e', at: 60, style: 'high', width: 60 },
  ],
  furniture: [
    { room: 'bath', item: 'tub', wall: 'w', at: 'start' },
    { room: 'bath', item: 'toilet', wall: 'n', at: 100 },
    { room: 'bath', item: 'vanity', wall: 'e', at: 135 },
    { room: 'bath', item: 'shelf', wall: 'n', at: 'end', w: 30 },
    { room: 'bath', item: 'sideTable', name: 'Laundry hamper', wall: 'w', at: 'end' },
  ],
}
