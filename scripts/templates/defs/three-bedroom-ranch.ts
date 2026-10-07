import { run, type TemplateDef } from '../dsl'

/** ~97 m2 (1,040 sq ft) single-storey ranch: great room, three bedrooms, one bath. */
export const threeBedroomRanch: TemplateDef = {
  id: 'three-bedroom-ranch',
  name: '3-Bedroom Ranch House Plan',
  category: 'Houses',
  description:
    'A single-storey three-bedroom ranch of about 980 sq ft: an open living, kitchen and dining great room across the front, and a bedroom wing off a central hall with a shared bathroom.',
  features: ['Open great room', 'Kitchen island with seating', 'Primary suite + two bedrooms', 'Patio door to the yard'],
  rooms: [
    { id: 'living', name: 'Living room', rect: [0, 0, 560, 480], floor: 'wood-oak' },
    { id: 'kitchen', name: 'Kitchen & dining', rect: [560, 0, 1100, 480], floor: 'wood-oak', open: ['w'] },
    { id: 'hall', name: 'Hall', rect: [0, 480, 1100, 590], floor: 'wood-oak', open: ['n'] },
    { id: 'bed2', name: 'Bedroom 2', rect: [0, 590, 320, 880], floor: 'carpet', kind: 'bedroom' },
    { id: 'bath', name: 'Bath', rect: [320, 590, 500, 880], floor: 'tile-floor', kind: 'bath' },
    { id: 'bed3', name: 'Bedroom 3', rect: [500, 590, 800, 880], floor: 'carpet', kind: 'bedroom' },
    { id: 'primary', name: 'Primary bedroom', rect: [800, 590, 1100, 880], floor: 'carpet', kind: 'bedroom' },
  ],
  openings: [
    { room: 'living', side: 'n', at: 160, style: 'picture', width: 200 },
    { room: 'living', side: 'n', at: 440, style: 'front' },
    { room: 'kitchen', side: 'n', at: 300, style: 'window' },
    { room: 'kitchen', side: 'e', at: 330, style: 'patio' },
    { room: 'bed2', side: 'n', at: 260, style: 'door' },
    { room: 'bed2', side: 's', at: 100, style: 'window' },
    { room: 'bath', side: 'n', at: 85, style: 'bathDoor' },
    { room: 'bath', side: 's', at: 85, style: 'high', width: 60 },
    { room: 'bed3', side: 'n', at: 40, style: 'door' },
    { room: 'bed3', side: 's', at: 150, style: 'window' },
    { room: 'primary', side: 'n', at: 40, style: 'door' },
    { room: 'primary', side: 's', at: 200, style: 'window' },
  ],
  furniture: [
    // Living room: sofa faces the TV wall.
    { room: 'living', item: 'rug', x: 220, y: 235, w: 240, d: 170 },
    { room: 'living', item: 'sofa', x: 330, y: 235, face: 'w' },
    { room: 'living', item: 'coffeeTable', x: 190, y: 235, face: 'w' },
    { room: 'living', item: 'tvStand', wall: 'w', at: 'center' },
    { room: 'living', item: 'tv', wall: 'w', at: 'center', gap: 16, elev: 52 },
    { room: 'living', item: 'armchair', wall: 'n', at: 300 },
    { room: 'living', item: 'plant', wall: 'n', at: 'end' },
    { room: 'living', item: 'sideTable', wall: 's', at: 'end' },
    { room: 'living', item: 'floorLamp', wall: 'w', at: 'end' },
    // Kitchen: one run along the window wall, island, and a dining table by the patio door.
    ...run('kitchen', 'n', 0, ['fridge', 'base', 'range', 'base', 'sink', 'dishwasher', 'base']),
    { room: 'kitchen', item: 'island', x: 200, y: 230 },
    { room: 'kitchen', item: 'stool', x: 150, y: 300 },
    { room: 'kitchen', item: 'stool', x: 200, y: 300 },
    { room: 'kitchen', item: 'stool', x: 250, y: 300 },
    { room: 'kitchen', item: 'diningTable', x: 360, y: 330 },
    { room: 'kitchen', item: 'chair', x: 330, y: 262, face: 's' },
    { room: 'kitchen', item: 'chair', x: 390, y: 262, face: 's' },
    { room: 'kitchen', item: 'chair', x: 330, y: 398, face: 'n' },
    { room: 'kitchen', item: 'chair', x: 390, y: 398, face: 'n' },
    // Bedroom 2 (guest / kid): twin bed + desk.
    { room: 'bed2', item: 'bedTwin', wall: 'w', at: 'start' },
    { room: 'bed2', item: 'nightstand', wall: 'w', at: 120 },
    { room: 'bed2', item: 'deskSmall', wall: 's', at: 100 },
    { room: 'bed2', item: 'officeChair', x: 100, y: 150 },
    { room: 'bed2', item: 'closet', wall: 'e', at: 'end' },
    // Bath.
    { room: 'bath', item: 'tub', wall: 's', at: 'center' },
    { room: 'bath', item: 'toilet', wall: 'e', at: 110 },
    { room: 'bath', item: 'vanity', wall: 'w', at: 110 },
    // Bedroom 3.
    { room: 'bed3', item: 'bedDouble', wall: 'e', at: 135 },
    { room: 'bed3', item: 'nightstand', wall: 'e', at: 32.5 },
    { room: 'bed3', item: 'nightstand', wall: 'e', at: 237.5 },
    { room: 'bed3', item: 'dresser', wall: 's', at: 'start' },
    // Primary bedroom.
    { room: 'primary', item: 'bedQueen', wall: 'e', at: 135 },
    { room: 'primary', item: 'nightstand', wall: 'e', at: 32.5 },
    { room: 'primary', item: 'nightstand', wall: 'e', at: 237.5 },
    { room: 'primary', item: 'wardrobe', wall: 's', at: 'start' },
  ],
}
