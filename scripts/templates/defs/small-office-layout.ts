import type { TemplateDef } from '../dsl'

/** Open office for four with a meeting room, about 63 m2. */
export const smallOfficeLayout: TemplateDef = {
  id: 'small-office-layout',
  name: 'Small Office Layout (4-Person)',
  category: 'Offices',
  description:
    'A small office layout for a four-person team: an open work area with four desks, file storage and a front reception shelf, plus a separate six-seat meeting room.',
  features: ['Four workstations', 'Six-seat meeting room', 'Reception console at the entry', 'File and shelf storage'],
  rooms: [
    { id: 'office', name: 'Open office', rect: [0, 0, 640, 480], floor: 'carpet' },
    { id: 'meeting', name: 'Meeting room', rect: [640, 0, 940, 480], floor: 'wood-oak' },
  ],
  openings: [
    { room: 'office', side: 'n', at: 150, style: 'window' },
    { room: 'office', side: 'n', at: 450, style: 'window' },
    { room: 'office', side: 's', at: 560, style: 'front' },
    { room: 'office', side: 'e', at: 420, style: 'door' },
    { room: 'meeting', side: 'n', at: 150, style: 'picture', width: 200 },
    { room: 'meeting', side: 'e', at: 240, style: 'window' },
  ],
  furniture: [
    { room: 'office', item: 'desk', x: 120, y: 90 },
    { room: 'office', item: 'officeChair', x: 120, y: 155, face: 'n' },
    { room: 'office', item: 'desk', x: 330, y: 90 },
    { room: 'office', item: 'officeChair', x: 330, y: 155, face: 'n' },
    { room: 'office', item: 'desk', x: 120, y: 270 },
    { room: 'office', item: 'officeChair', x: 120, y: 335, face: 'n' },
    { room: 'office', item: 'desk', x: 330, y: 270 },
    { room: 'office', item: 'officeChair', x: 330, y: 335, face: 'n' },
    { room: 'office', item: 'filing', wall: 'e', at: 100 },
    { room: 'office', item: 'filing', wall: 'e', at: 150 },
    { room: 'office', item: 'shelf', wall: 'w', at: 220 },
    { room: 'office', item: 'console', wall: 's', at: 330 },
    { room: 'office', item: 'plant', wall: 'n', at: 'end' },
    { room: 'meeting', item: 'conferenceTable', x: 140, y: 230 },
    { room: 'meeting', item: 'officeChair', x: 70, y: 150, face: 's' },
    { room: 'meeting', item: 'officeChair', x: 140, y: 150, face: 's' },
    { room: 'meeting', item: 'officeChair', x: 210, y: 150, face: 's' },
    { room: 'meeting', item: 'officeChair', x: 70, y: 310, face: 'n' },
    { room: 'meeting', item: 'officeChair', x: 140, y: 310, face: 'n' },
    { room: 'meeting', item: 'officeChair', x: 210, y: 310, face: 'n' },
    { room: 'meeting', item: 'tv', wall: 'e', at: 'center', elev: 90 },
    { room: 'meeting', item: 'bookcase', wall: 's', at: 'end' },
  ],
}
