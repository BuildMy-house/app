import type { TemplateDef } from '../dsl'
import { backyardAduCottage } from './backyard-adu-cottage'
import { basementRecRoom } from './basement-rec-room'
import { diningRoom } from './dining-room-12x12'
import { fullBathroom } from './full-bathroom-5x8'
import { galleyKitchen } from './galley-kitchen'
import { garageConversionStudio } from './garage-conversion-studio'
import { homeOffice } from './home-office-10x12'
import { kidsBedroom } from './kids-bedroom'
import { lShapedKitchenDiner } from './l-shaped-kitchen-diner'
import { livingRoom } from './living-room'
import { oneBedroomApartment } from './one-bedroom-apartment'
import { openPlanLivingKitchenDining } from './open-plan-living-kitchen-dining'
import { primaryBedroomSuite } from './primary-bedroom-suite'
import { smallCabin } from './small-cabin'
import { smallOfficeLayout } from './small-office-layout'
import { studioApartment } from './studio-apartment'
import { threeBedroomRanch } from './three-bedroom-ranch'
import { tinyHouse } from './tiny-house'
import { twoBedroomApartment } from './two-bedroom-apartment'
import { twoBedroomBungalow } from './two-bedroom-bungalow'

export const TEMPLATES: TemplateDef[] = [
  livingRoom,
  threeBedroomRanch,
  twoBedroomBungalow,
  studioApartment,
  lShapedKitchenDiner,
  tinyHouse,
  garageConversionStudio,
  smallOfficeLayout,
  homeOffice,
  oneBedroomApartment,
  twoBedroomApartment,
  openPlanLivingKitchenDining,
  primaryBedroomSuite,
  kidsBedroom,
  galleyKitchen,
  fullBathroom,
  diningRoom,
  backyardAduCottage,
  smallCabin,
  basementRecRoom,
]
