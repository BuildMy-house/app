import { run, type TemplateDef } from '../dsl'

/** ~55 m2 (590 sq ft) one-bedroom with open kitchen and en-suite bath. */
export const oneBedroomApartment: TemplateDef = {
  id: 'one-bedroom-apartment',
  name: '1-Bedroom Apartment Floor Plan',
  category: 'Apartments',
  description:
    'A one-bedroom apartment of about 550 sq ft: living room open to the kitchen with a bar counter, a bedroom with wardrobe and desk, and an en-suite bath with laundry.',
  features: ['Open living and kitchen', 'Bar counter with seating', 'En-suite bath with laundry', 'Bedroom with wardrobe + desk'],
  rooms: [
    { id: 'living', name: 'Living room', rect: [0, 0, 500, 400], floor: 'wood-oak' },
    { id: 'kitchen', name: 'Kitchen & dining', rect: [0, 400, 500, 640], floor: 'wood-oak', open: ['n'] },
    { id: 'bedroom', name: 'Bedroom', rect: [500, 0, 860, 420], floor: 'carpet', kind: 'bedroom' },
    { id: 'bath', name: 'Bath & laundry', rect: [500, 420, 860, 640], floor: 'tile-floor', kind: 'bath' },
  ],
  openings: [
    { room: 'living', side: 'n', at: 250, style: 'picture', width: 200 },
    { room: 'living', side: 'w', at: 330, style: 'window' },
    { room: 'kitchen', side: 's', at: 310, style: 'window' },
    { room: 'kitchen', side: 's', at: 445, style: 'front' },
    { room: 'bedroom', side: 'w', at: 90, style: 'door' },
    { room: 'bedroom', side: 'n', at: 180, style: 'window' },
    { room: 'bedroom', side: 'e', at: 200, style: 'small' },
    { room: 'bath', side: 'n', at: 60, style: 'bathDoor' },
    { room: 'bath', side: 'e', at: 100, style: 'high', width: 60 },
  ],
  furniture: [
    // Living room: sofa faces the TV on the west wall.
    { room: 'living', item: 'tvStand', wall: 'w', at: 200 },
    { room: 'living', item: 'tv', wall: 'w', at: 200, gap: 16, elev: 52 },
    { room: 'living', item: 'rug', x: 190, y: 200, w: 260, d: 200 },
    { room: 'living', item: 'sofa', x: 240, y: 200, face: 'w' },
    { room: 'living', item: 'coffeeTable', x: 150, y: 200, face: 'w' },
    { room: 'living', item: 'armchair', wall: 'n', at: 70 },
    { room: 'living', item: 'plant', wall: 'w', at: 'end' },
    // Kitchen and dining.
    ...run('kitchen', 's', 0, ['fridge', 'base', 'range', 'base', 'sink']),
    { room: 'kitchen', item: 'barCounter', x: 130, y: 25 },
    { room: 'living', item: 'stool', x: 100, y: 370 },
    { room: 'living', item: 'stool', x: 160, y: 370 },
    { room: 'kitchen', item: 'diningTableSq', x: 330, y: 90 },
    { room: 'kitchen', item: 'chair', x: 252, y: 90, face: 'e' },
    { room: 'kitchen', item: 'chair', x: 408, y: 90, face: 'w' },
    // Bedroom.
    { room: 'bedroom', item: 'bedQueen', wall: 'e', at: 200 },
    { room: 'bedroom', item: 'nightstand', wall: 'e', at: 97.5 },
    { room: 'bedroom', item: 'nightstand', wall: 'e', at: 302.5 },
    { room: 'bedroom', item: 'wardrobe', wall: 's', at: 'end' },
    { room: 'bedroom', item: 'deskSmall', wall: 'w', at: 270 },
    { room: 'bedroom', item: 'officeChair', x: 105, y: 270, face: 'w' },
    // Bath and laundry.
    { room: 'bath', item: 'tub', wall: 's', at: 'start' },
    { room: 'bath', item: 'toilet', wall: 'e', at: 100 },
    { room: 'bath', item: 'vanity', wall: 'w', at: 100 },
    { room: 'bath', item: 'washer', wall: 'n', at: 'end' },
    { room: 'bath', item: 'dryer', wall: 'n', at: 255 },
  ],
}
