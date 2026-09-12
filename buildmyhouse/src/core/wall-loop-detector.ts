/**
 * WallLoopDetector — pure geometry module for detecting closed wall loops.
 *
 * Used by the auto-floor feature to find rooms formed by connected walls.
 * No UI, no side effects, no external dependencies.
 */

export interface Wall {
  id: string
  start: { x: number; y: number }
  end: { x: number; y: number }
}

export interface WallLoop {
  walls: Wall[]
  area: number
  vertices: Array<{ x: number; y: number }>
}

/** Squared distance between two points. */
function dist2(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

/** Check if two endpoints are within tolerance (squared comparison to avoid sqrt). */
function endpointsMatch(
  a: { x: number; y: number },
  b: { x: number; y: number },
  toleranceSq: number,
): boolean {
  return dist2(a, b) <= toleranceSq
}

/**
 * Compute signed area of a polygon using the shoelace formula.
 * Positive = counterclockwise, negative = clockwise.
 */
function shoelaceArea(vertices: Array<{ x: number; y: number }>): number {
  let area = 0
  const n = vertices.length
  for (let i = 0; i < n; i++) {
    const curr = vertices[i]!
    const next = vertices[(i + 1) % n]!
    area += curr.x * next.y
    area -= next.x * curr.y
  }
  return area / 2
}

/**
 * Build adjacency graph: for each endpoint of each wall, find which other walls
 * connect at that point (within tolerance).
 *
 * Returns: Map<wallId, [wallId, ...]> — neighbors reachable from either end.
 * Also returns the "oriented" adjacency: for each wall, which wall connects at
 * its start vs end, to walk cycles in order.
 */
function buildGraph(
  walls: Wall[],
  toleranceSq: number,
): { neighbors: Map<string, Set<string>>; atEnd: Map<string, string[]> } {
  const neighbors = new Map<string, Set<string>>()
  const atEnd = new Map<string, string[]>()

  for (const w of walls) {
    neighbors.set(w.id, new Set())
    atEnd.set(w.id, [])
  }

  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const a = walls[i]!
      const b = walls[j]!

      // a.start ↔ b.start
      if (endpointsMatch(a.start, b.start, toleranceSq)) {
        neighbors.get(a.id)!.add(b.id)
        neighbors.get(b.id)!.add(a.id)
      }
      // a.start ↔ b.end
      if (endpointsMatch(a.start, b.end, toleranceSq)) {
        neighbors.get(a.id)!.add(b.id)
        neighbors.get(b.id)!.add(a.id)
        atEnd.get(b.id)!.push(a.id)
      }
      // a.end ↔ b.start
      if (endpointsMatch(a.end, b.start, toleranceSq)) {
        neighbors.get(a.id)!.add(b.id)
        neighbors.get(b.id)!.add(a.id)
        atEnd.get(a.id)!.push(b.id)
      }
      // a.end ↔ b.end
      if (endpointsMatch(a.end, b.end, toleranceSq)) {
        neighbors.get(a.id)!.add(b.id)
        neighbors.get(b.id)!.add(a.id)
        atEnd.get(a.id)!.push(b.id)
        atEnd.get(b.id)!.push(a.id)
      }
    }
  }

  return { neighbors, atEnd }
}

/**
 * Walk a cycle starting from `startWall`, returning the wall sequence.
 * Follows the path: from each wall's end, pick the next unvisited neighbor.
 * Returns null if no valid cycle of length ≥ 3 is found.
 */
function walkCycle(
  startWallId: string,
  wallMap: Map<string, Wall>,
  atEnd: Map<string, string[]>,
): Wall[] | null {
  const visited = new Set<string>()
  const cycle: Wall[] = []
  let currentId = startWallId

  for (;;) {
    if (visited.has(currentId)) {
      if (currentId === startWallId && cycle.length >= 3) {
        return cycle
      }
      return null
    }

    visited.add(currentId)
    cycle.push(wallMap.get(currentId)!)

    const candidates = atEnd.get(currentId)!

    let nextId: string | null = null
    for (const candId of candidates) {
      if (candId === startWallId && cycle.length >= 3) {
        nextId = candId
        break
      }
      if (!visited.has(candId)) {
        nextId = candId
        break
      }
    }

    if (nextId === null) return null
    if (nextId === startWallId && cycle.length >= 3) return cycle
    currentId = nextId
  }
}

/**
 * Detect closed loops of walls using tolerance-based endpoint matching.
 *
 * Algorithm:
 * 1. Build adjacency graph connecting walls whose endpoints are within tolerance
 * 2. DFS from each unvisited wall to find cycles
 * 3. Validate cycles: ≥3 walls, area ≥ 0.1, no T-junctions (degree-2 path)
 * 4. Return validated loops with vertices and area
 *
 * @param walls - Array of Wall objects with start/end points
 * @param tolerance - Max distance to consider endpoints connected (default 0.01)
 * @returns Array of WallLoop objects (validated closed loops)
 */
export function detectClosedLoops(walls: Wall[], tolerance = 0.01): WallLoop[] {
  if (walls.length < 3) return []

  const toleranceSq = tolerance * tolerance
  const wallMap = new Map<string, Wall>()
  for (const w of walls) {
    wallMap.set(w.id, w)
  }

  const { neighbors, atEnd } = buildGraph(walls, toleranceSq)

  const globalVisited = new Set<string>()
  const loops: WallLoop[] = []

  for (const wall of walls) {
    if (globalVisited.has(wall.id)) continue

    // Attempt to walk a cycle from this wall
    const cycle = walkCycle(wall.id, wallMap, atEnd)
    if (cycle === null) continue

    // Validate: every wall in the cycle must have exactly 2 neighbors within the cycle
    const cycleIds = new Set(cycle.map((w) => w.id))
    let valid = true
    for (const w of cycle) {
      let count = 0
      for (const n of Array.from(neighbors.get(w.id)!)) {
        if (cycleIds.has(n)) count++
      }
      if (count !== 2) {
        valid = false
        break
      }
    }
    if (!valid) continue

    // Compute vertices: walk the cycle and collect the endpoint that connects forward
    const vertices: Array<{ x: number; y: number }> = []
    for (let i = 0; i < cycle.length; i++) {
      const curr = cycle[i]!
      const next = cycle[(i + 1) % cycle.length]!
      // Find which endpoint of curr connects to next
      if (
        endpointsMatch(curr.end, next.start, toleranceSq) ||
        endpointsMatch(curr.end, next.end, toleranceSq)
      ) {
        vertices.push({ x: curr.start.x, y: curr.start.y })
      } else {
        vertices.push({ x: curr.end.x, y: curr.end.y })
      }
    }

    const area = Math.abs(shoelaceArea(vertices))
    if (area < 0.1) continue

    loops.push({ walls: cycle, area, vertices })

    for (const w of cycle) {
      globalVisited.add(w.id)
    }
  }

  return loops
}
