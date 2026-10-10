import { run, type TemplateDef } from '../dsl'

/** ~80 m2 (860 sq ft) bungalow: living room, separate kitchen/dining, hall, two bedrooms, bath. */
export const twoBedroomBungalow: TemplateDef = {
  id: 'two-bedroom-bungalow',
  name: '2-Bedroom Bungalow Floor Plan',
  category: 'Houses',
  description:
    'A compact two-bedroom bungalow of about 800 sq ft with a separate living room, an eat-in kitchen, a full bath, and a bedroom wing off a straight hall.',
  features: ['Separate eat-in kitchen', 'Straight hall to bedrooms', 'Full bath with tub', 'Two bedrooms with closets'],
  rooms: [
    { id: 'living', name: 'Living room', rect: [0, 0, 540, 460], floor: 'wood-oak' },
    { id: 'kitchen', name: 'Kitchen & dining', rect: [0, 460, 540, 860], floor: 'tile-floor' },
    { id: 'hall', name: 'Hall', rect: [540, 0, 640, 860], floor: 'wood-oak' },
    { id: 'bed2', name: 'Bedroom 2', rect: [640, 0, 940, 330], floor: 'carpet', kind: 'bedroom' },
    { id: 'bath', name: 'Bath', rect: [640, 330, 940, 560], floor: 'tile-floor', kind: 'bath' },
    { id: 'primary', name: 'Primary bedroom', rect: [640, 560, 940, 860], floor: 'carpet', kind: 'bedroom' },
  ],
  openings: [
    { room: 'living', side: 'w', at: 230, style: 'front' },
    { room: 'living', side: 'n', at: 270, style: 'picture', width: 200 },
    { room: 'living', side: 's', at: 200, style: 'door' },
    { room: 'living', side: 'e', at: 230, style: 'door' },
    { room: 'kitchen', side: 'e', at: 100, style: 'door' },
    { room: 'kitchen', side: 'w', at: 255, style: 'window' },
    { room: 'kitchen', side: 's', at: 400, style: 'window' },
    { room: 'bed2', side: 'w', at: 60, style: 'door' },
    { room: 'bed2', side: 'n', at: 150, style: 'window' },
    { room: 'bed2', side: 'e', at: 160, style: 'small' },
    { room: 'bath', side: 'w', at: 110, style: 'bathDoor' },
    { room: 'bath', side: 'n', at: 100, style: 'high', width: 60 },
    { room: 'primary', side: 'w', at: 50, style: 'door' },
    { room: 'primary', side: 's', at: 200, style: 'window' },
    { room: 'primary', side: 'e', at: 150, style: 'small' },
  ],
  furniture: [
    // Living room.
    { room: 'living', item: 'rug', x: 270, y: 150, w: 260, d: 180 },
    { room: 'living', item: 'sofa', wall: 'n', at: 270 },
    { room: 'living', item: 'coffeeTable', x: 270, y: 150 },
    { room: 'living', item: 'tvStand', wall: 's', at: 380 },
    { room: 'living', item: 'tv', wall: 's', at: 380, gap: 16, elev: 52, },
    { room: 'living', item: 'armchair', wall: 'w', at: 90, },
    { room: 'living', item: 'bookcase', wall: 'e', at: 'start' },
    { room: 'living', item: 'floorLamp', wall: 'n', at: 'start' },
    { room: 'living', item: 'plant', wall: 's', at: 'end' },
    { room: 'living', item: 'sideTable', wall: 'n', at: 90 },
    // Kitchen & dining.
    ...run('kitchen', 'w', 0, ['fridge', 'base', 'range', 'sink', 'dishwasher']),
    { room: 'kitchen', item: 'diningTable', x: 300, y: 250 },
    { room: 'kitchen', item: 'chair', x: 260, y: 184, face: 's' },
    { room: 'kitchen', item: 'chair', x: 340, y: 184, face: 's' },
    { room: 'kitchen', item: 'chair', x: 260, y: 316, face: 'n' },
    { room: 'kitchen', item: 'chair', x: 340, y: 316, face: 'n' },
    { room: 'kitchen', item: 'sideboard', wall: 'n', at: 400 },
    { room: 'kitchen', item: 'pantry', wall: 's', at: 'end' },
    // Bedroom 2.
    { room: 'bed2', item: 'bedQueen', wall: 'e', at: 157 },
    { room: 'bed2', item: 'nightstand', wall: 'e', at: 54.5 },
    { room: 'bed2', item: 'nightstand', wall: 'e', at: 259.5 },
    { room: 'bed2', item: 'wardrobe', wall: 's', at: 'start' },
    // Bath.
    { room: 'bath', item: 'tub', wall: 's', at: 'start' },
    { room: 'bath', item: 'toilet', wall: 'e', at: 110 },
    { room: 'bath', item: 'vanity', wall: 'n', at: 220 },
    // Primary bedroom.
    { room: 'primary', item: 'bedQueen', wall: 'e', at: 135 },
    { room: 'primary', item: 'nightstand', wall: 'e', at: 32.5 },
    { room: 'primary', item: 'nightstand', wall: 'e', at: 237.5 },
    { room: 'primary', item: 'wardrobe', wall: 's', at: 'start' },
  ],
}
