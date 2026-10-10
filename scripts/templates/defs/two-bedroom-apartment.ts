import { run, type TemplateDef } from '../dsl'

/** ~85 m2 (915 sq ft) two-bedroom apartment: open living and kitchen with an island. */
export const twoBedroomApartment: TemplateDef = {
  id: 'two-bedroom-apartment',
  name: '2-Bedroom Apartment Floor Plan',
  category: 'Apartments',
  description:
    'A two-bedroom apartment of about 650 sq ft with an open living room and kitchen, a work island with seating, a dining table, a shared bath, and a primary bedroom with wardrobe.',
  features: ['Open living, kitchen and dining', 'Kitchen island with three stools', 'Primary bedroom + guest bedroom', 'Shared bath with tub'],
  rooms: [
    { id: 'living', name: 'Living room', rect: [0, 0, 520, 400], floor: 'wood-oak' },
    { id: 'kitchen', name: 'Kitchen & dining', rect: [0, 400, 520, 720], floor: 'wood-oak', open: ['n'] },
    { id: 'bed2', name: 'Bedroom 2', rect: [520, 0, 900, 300], floor: 'carpet', kind: 'bedroom' },
    { id: 'bath', name: 'Bath', rect: [520, 300, 900, 450], floor: 'tile-floor', kind: 'bath' },
    { id: 'primary', name: 'Primary bedroom', rect: [520, 450, 900, 720], floor: 'carpet', kind: 'bedroom' },
  ],
  openings: [
    { room: 'living', side: 'n', at: 260, style: 'picture', width: 200 },
    { room: 'living', side: 'w', at: 330, style: 'window' },
    { room: 'living', side: 'e', at: 340, style: 'bathDoor' },
    { room: 'kitchen', side: 'w', at: 120, style: 'window' },
    { room: 'kitchen', side: 's', at: 310, style: 'window' },
    { room: 'kitchen', side: 's', at: 460, style: 'front' },
    { room: 'kitchen', side: 'e', at: 140, style: 'door' },
    { room: 'bed2', side: 'w', at: 60, style: 'door' },
    { room: 'bed2', side: 'n', at: 190, style: 'window' },
    { room: 'bed2', side: 'e', at: 150, style: 'small' },
    { room: 'bath', side: 'e', at: 75, style: 'high', width: 60 },
    { room: 'primary', side: 's', at: 190, style: 'window' },
    { room: 'primary', side: 'e', at: 130, style: 'small' },
  ],
  furniture: [
    // Living room.
    { room: 'living', item: 'tvStand', wall: 'w', at: 190 },
    { room: 'living', item: 'tv', wall: 'w', at: 190, gap: 16, elev: 52 },
    { room: 'living', item: 'rug', x: 200, y: 190, w: 280, d: 200 },
    { room: 'living', item: 'sofa', x: 250, y: 190, face: 'w' },
    { room: 'living', item: 'coffeeTable', x: 160, y: 190, face: 'w' },
    { room: 'living', item: 'sideTable', x: 250, y: 330 },
    { room: 'living', item: 'armchair', wall: 'n', at: 80 },
    { room: 'living', item: 'plant', wall: 'w', at: 'end' },
    // Kitchen and dining.
    ...run('kitchen', 's', 0, ['fridge', 'base', 'range', 'base', 'sink']),
    { room: 'kitchen', item: 'island', x: 150, y: 120 },
    { room: 'kitchen', item: 'stool', x: 100, y: 53, face: 's' },
    { room: 'kitchen', item: 'stool', x: 150, y: 53, face: 's' },
    { room: 'kitchen', item: 'stool', x: 200, y: 53, face: 's' },
    { room: 'kitchen', item: 'diningTable', x: 330, y: 120 },
    { room: 'kitchen', item: 'chair', x: 295, y: 54, face: 's' },
    { room: 'kitchen', item: 'chair', x: 365, y: 54, face: 's' },
    { room: 'kitchen', item: 'chair', x: 295, y: 186, face: 'n' },
    { room: 'kitchen', item: 'chair', x: 365, y: 186, face: 'n' },
    // Bedroom 2.
    { room: 'bed2', item: 'bedDouble', wall: 'e', at: 150 },
    { room: 'bed2', item: 'nightstand', wall: 'e', at: 57.5 },
    { room: 'bed2', item: 'nightstand', wall: 'e', at: 242.5 },
    { room: 'bed2', item: 'wardrobe', wall: 's', at: 'start' },
    // Bath.
    { room: 'bath', item: 'tub', wall: 's', at: 'end' },
    { room: 'bath', item: 'toilet', wall: 'e', at: 40 },
    { room: 'bath', item: 'vanity', wall: 'n', at: 200 },
    // Primary bedroom.
    { room: 'primary', item: 'bedQueen', wall: 'e', at: 127 },
    { room: 'primary', item: 'nightstand', wall: 'e', at: 24.5 },
    { room: 'primary', item: 'nightstand', wall: 'e', at: 229.5 },
    { room: 'primary', item: 'closet', wall: 's', at: 'start' },
  ],
}
