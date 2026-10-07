import type { Wall } from './home'

/**
 * Where a door/window sits when attached to `wall` at `xAlongWall` cm from the
 * wall's start, rotated to the wall angle. `lateralCm` shifts it off the wall
 * centerline towards the wall's left side; the automation add_door/add_window
 * default (half the wall thickness) puts it on the left face line, templates
 * pass 0 to centre the frame in the wall. Shared so both place openings by the
 * same geometry.
 */
export function openingOnWall(
  wall: Pick<Wall, 'xStart' | 'yStart' | 'xEnd' | 'yEnd' | 'thickness'>,
  xAlongWall: number,
  lateralCm: number = wall.thickness / 2,
): { x: number; y: number; angleDeg: number; offset: number } {
  const dx = wall.xEnd - wall.xStart
  const dy = wall.yEnd - wall.yStart
  const wallLen = Math.hypot(dx, dy) || 1
  const nx = dx / wallLen
  const ny = dy / wallLen
  const t = Math.max(0, Math.min(wallLen, xAlongWall))
  return {
    x: wall.xStart + nx * t + -ny * lateralCm,
    y: wall.yStart + ny * t + nx * lateralCm,
    angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
    offset: t,
  }
}
