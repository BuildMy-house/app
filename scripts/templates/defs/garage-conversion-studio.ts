import { run, type TemplateDef } from '../dsl'

/** 6 x 6 m two-car garage converted into a studio with a bedroom and bath. */
export const garageConversionStudio: TemplateDef = {
  id: 'garage-conversion-studio',
  name: 'Garage Conversion Studio Plan (2-Car)',
  category: 'Small spaces',
  description:
    'A two-car garage converted into a 33 m2 (about 355 sq ft) studio dwelling: a living and kitchen room behind a glass-door wall where the garage door was, plus a separate bedroom and bath.',
  features: ['Glass double doors replace the garage door', 'Kitchen run and dining for four', 'Separate bedroom', 'Full bath with tub'],
  rooms: [
    { id: 'living', name: 'Living & kitchen', rect: [0, 0, 600, 360], floor: 'concrete' },
    { id: 'bedroom', name: 'Bedroom', rect: [0, 360, 400, 600], floor: 'wood-pine', kind: 'bedroom' },
    { id: 'bath', name: 'Bath', rect: [400, 360, 600, 600], floor: 'tile-floor', kind: 'bath' },
  ],
  openings: [
    { room: 'living', side: 'n', at: 300, style: 'double' },
    { room: 'living', side: 'w', at: 130, style: 'window' },
    { room: 'living', side: 'e', at: 60, style: 'small' },
    { room: 'bedroom', side: 'n', at: 270, style: 'door' },
    { room: 'bedroom', side: 'w', at: 90, style: 'small' },
    { room: 'bedroom', side: 's', at: 150, style: 'small' },
    { room: 'bath', side: 'w', at: 60, style: 'bathDoor' },
    { room: 'bath', side: 'n', at: 100, style: 'high', width: 60 },
  ],
  furniture: [
    ...run('living', 'w', 0, ['fridge', 'sink', 'range']),
    { room: 'living', item: 'diningTable', x: 150, y: 200 },
    { room: 'living', item: 'chair', x: 120, y: 134, face: 's' },
    { room: 'living', item: 'chair', x: 180, y: 134, face: 's' },
    { room: 'living', item: 'chair', x: 120, y: 266, face: 'n' },
    { room: 'living', item: 'chair', x: 180, y: 266, face: 'n' },
    { room: 'living', item: 'tvStand', wall: 'e', at: 177 },
    { room: 'living', item: 'tv', wall: 'e', at: 177, gap: 16, elev: 52 },
    { room: 'living', item: 'sofa', x: 390, y: 177, face: 'e' },
    { room: 'living', item: 'coffeeTable', x: 460, y: 177, face: 'e' },
    { room: 'living', item: 'rug', x: 440, y: 177, w: 200, d: 240 },
    { room: 'bedroom', item: 'bedDouble', wall: 'w', at: 80 },
    { room: 'bedroom', item: 'nightstand', wall: 'w', at: 182.5 },
    { room: 'bedroom', item: 'closet', wall: 'e', at: 'end' },
    { room: 'bath', item: 'tub', wall: 's', at: 'center' },
    { room: 'bath', item: 'toilet', wall: 'e', at: 80 },
    { room: 'bath', item: 'vanity', wall: 'n', at: 130 },
  ],
}
