import type { TemplateDef } from '../dsl'

/** 9.4 x 5.0 m finished basement. */
export const basementRecRoom: TemplateDef = {
  id: 'basement-rec-room',
  name: 'Finished Basement Rec Room Layout',
  category: 'Single rooms',
  description:
    'A finished basement of about 34 m2 (370 sq ft): a rec room with TV area, bar and pool table, plus a laundry and utility room and a full bath.',
  features: ['TV lounge with sofa', 'Pool table and bar with stools', 'Laundry and utility room', 'Full bath with tub'],
  rooms: [
    { id: 'rec', name: 'Rec room', rect: [0, 0, 520, 520], floor: 'carpet' },
    { id: 'utility', name: 'Laundry & utility', rect: [520, 0, 720, 260], floor: 'concrete' },
    { id: 'bath', name: 'Bath', rect: [520, 260, 720, 520], floor: 'tile-floor', kind: 'bath' },
  ],
  openings: [
    { room: 'rec', side: 'w', at: 400, style: 'door' },
    { room: 'rec', side: 'n', at: 330, style: 'high' },
    { room: 'rec', side: 'n', at: 440, style: 'high' },
    { room: 'rec', side: 's', at: 300, style: 'high' },
    { room: 'utility', side: 'w', at: 130, style: 'door' },
    { room: 'utility', side: 'n', at: 150, style: 'high' },
    { room: 'bath', side: 'w', at: 40, style: 'bathDoor' },
    { room: 'bath', side: 'e', at: 100, style: 'high', width: 60 },
  ],
  furniture: [
    { room: 'rec', item: 'tvStand', wall: 'n', at: 140 },
    { room: 'rec', item: 'tv', wall: 'n', at: 140, gap: 16, elev: 52 },
    { room: 'rec', item: 'rug', x: 140, y: 200 },
    { room: 'rec', item: 'coffeeTable', x: 140, y: 200 },
    { room: 'rec', item: 'sofa', x: 140, y: 300, face: 'n' },
    { room: 'rec', item: 'armchair', wall: 'w', at: 190 },
    { room: 'rec', item: 'conferenceTable', name: 'Pool table', x: 355, y: 290, face: 'e', w: 230, d: 125, color: 0x2f6b4a },
    { room: 'rec', item: 'barCounter', wall: 's', at: 150 },
    { room: 'rec', item: 'stool', x: 120, y: 425 },
    { room: 'rec', item: 'stool', x: 180, y: 425 },
    { room: 'rec', item: 'fridge', wall: 's', at: 260 },
    { room: 'rec', item: 'plant', wall: 's', at: 'end' },
    { room: 'utility', item: 'washer', wall: 'n', at: 'start' },
    { room: 'utility', item: 'dryer', wall: 'n', at: 92 },
    { room: 'utility', item: 'waterHeater', wall: 'e', at: 120 },
    { room: 'utility', item: 'shelf', wall: 'e', at: 'end' },
    { room: 'bath', item: 'tub', wall: 's', at: 'end' },
    { room: 'bath', item: 'toilet', wall: 'e', at: 110 },
    { room: 'bath', item: 'vanity', wall: 'n', at: 120 },
  ],
}
