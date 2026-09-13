import { describe, expect, it } from 'vitest'
import {
  COMPASS_FALLBACK_ZONE,
  compassDegreesForZone,
  compassRadiansForZone,
  resolveTimezone,
} from '../src/core/compass-timezones'
import { roundHalfEven } from '../src/core/export'
import { createEmptyHome } from '../src/core/home'

/** Java pipeline: (float)deg -> Math.toRadians(deg/180*PI as double) -> (float). */
function javaFloatRadians(degrees: number): number {
  return Math.fround((Math.fround(degrees) / 180) * Math.PI)
}

describe('compass timezone table (SH3D Compass.java port, 603 entries)', () => {
  it('Asia/Thimphu exports round3 radians matching the driver golden (0.48 / 1.564)', () => {
    const deg = compassDegreesForZone('Asia/Thimphu')
    expect(deg).toEqual([27.4833333, 89.6])
    const { latitudeRad, longitudeRad } = compassRadiansForZone('Asia/Thimphu')
    expect(latitudeRad).toBe(javaFloatRadians(27.4833333))
    expect(longitudeRad).toBe(javaFloatRadians(89.6))
    // Golden create_room.expected-state.json (build machine zone = Asia/Thimphu)
    expect(roundHalfEven(latitudeRad)).toBe(0.48)
    expect(roundHalfEven(longitudeRad)).toBe(1.564)
  })

  it('Asia/Kolkata maps to Calcutta degrees (22.569722, 88.369722)', () => {
    expect(compassDegreesForZone('Asia/Kolkata')).toEqual([22.569722, 88.369722])
    expect(compassDegreesForZone('Asia/Calcutta')).toEqual([22.569722, 88.369722])
    const { latitudeRad, longitudeRad } = compassRadiansForZone('Asia/Kolkata')
    expect(roundHalfEven(latitudeRad)).toBe(roundHalfEven(javaFloatRadians(22.569722)))
    expect(roundHalfEven(longitudeRad)).toBe(roundHalfEven(javaFloatRadians(88.369722)))
    expect(roundHalfEven(latitudeRad)).toBe(0.394)
    expect(roundHalfEven(longitudeRad)).toBe(1.542)
  })

  it('UTC/Greenwich/Etc/GMT share the Greenwich Observatory entry (51.466667, 0)', () => {
    // Compass.java:673 — NOT (0,0); kickoff-prompt assumption corrected here.
    for (const zone of ['UTC', 'Greenwich', 'Etc/GMT', COMPASS_FALLBACK_ZONE]) {
      expect(compassDegreesForZone(zone)).toEqual([51.466667, 0])
      expect(roundHalfEven(compassRadiansForZone(zone).latitudeRad)).toBe(0.898)
      expect(roundHalfEven(compassRadiansForZone(zone).longitudeRad)).toBe(0)
    }
  })

  it('unknown zones fall back to Etc/GMT', () => {
    expect(compassRadiansForZone('Mars/Olympus_Mons')).toEqual(
      compassRadiansForZone(COMPASS_FALLBACK_ZONE),
    )
    expect(compassRadiansForZone(null)).toEqual(compassRadiansForZone(COMPASS_FALLBACK_ZONE))
    expect(compassRadiansForZone(undefined)).toEqual(compassRadiansForZone(COMPASS_FALLBACK_ZONE))
  })

  it('createEmptyHome injects the zone; omitted reads the OS timezone', () => {
    const thimphu = createEmptyHome('Asia/Thimphu').compass
    const utc = createEmptyHome('UTC').compass
    expect(thimphu.latitudeRad).not.toBe(utc.latitudeRad)
    expect(createEmptyHome().compass.latitudeRad).toBe(
      compassRadiansForZone(resolveTimezone()).latitudeRad,
    )
  })

  it('resolveTimezone returns a non-empty IANA id on this platform', () => {
    expect(resolveTimezone()).toBeTruthy()
  })
})
