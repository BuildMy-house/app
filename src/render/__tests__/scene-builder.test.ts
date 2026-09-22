import { describe, it, expect } from 'vitest'
import { buildRenderableScene } from '../scene-builder'
import { createEmptyHome } from '../../core/home'

describe('buildRenderableScene', () => {
  it('exports roof panels as renderable 3D primitives with overhang', () => {
    const home = createEmptyHome()
    home.roofs.push({
      id: 'roof-1', points: [[0, 0], [400, 0], [400, 200], [0, 200]],
      style: 'gable', pitchDeg: 30, overhangCm: 20,
    })

    const { scene } = buildRenderableScene(home)
    const roof = scene.objects.find((object) => object.id === 'roof:roof-1')!
    expect(roof.primitives).toHaveLength(2)
    expect(roof.primitives.every((primitive) => primitive.type === 'box')).toBe(true)
    expect(roof.visible.luxcore).toBe(true)
    const first = roof.primitives[0]!
    expect(first.type).toBe('box')
    if (first.type === 'box') expect(first.size[0]).toBe(440)
  })
  it('returns valid scene for empty home', () => {
    const home = createEmptyHome()
    const { scene } = buildRenderableScene(home)
    expect(scene.version).toBe(1)
    expect(scene.materials).toEqual([])
    expect(scene.objects).toEqual([])
    expect(scene.lights.length).toBeGreaterThan(0)
  })

  it('creates materials for walls', () => {
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1',
      xStart: 0, yStart: 0,
      xEnd: 400, yEnd: 0,
      thickness: 15,
      leftSideColor: 0xFF0000,
      rightSideColor: 0x00FF00,
    })
    const { scene } = buildRenderableScene(home)
    expect(scene.materials.length).toBe(2)
    expect(scene.objects.length).toBe(1)
    expect(scene.objects[0]!.id).toBe('wall:w1')
  })

  it('creates floor and ceiling for rooms', () => {
    const home = createEmptyHome()
    home.levels.push({
      id: 'l1', name: 'Ground', elevation: 0,
      floorThickness: 10, height: 250,
      visible: true, viewable: true,
    })
    home.rooms.push({
      id: 'r1',
      points: [[0,0], [400,0], [400,300], [0,300]],
      floorColor: 0x123456,
      ceilingVisible: true,
    })
    const { scene } = buildRenderableScene(home)
    const roomObjs = scene.objects.filter(o => o.id.startsWith('room:') || o.id.startsWith('ceiling:'))
    expect(roomObjs.length).toBe(2)
  })

  it('skips invisible furniture', () => {
    const home = createEmptyHome()
    home.furniture.push({
      id: 'f1', name: 'Table',
      x: 100, y: 100, angleDeg: 0,
      width: 80, depth: 80, height: 75,
      elevation: 0, visible: false,
    })
    const { scene } = buildRenderableScene(home)
    expect(scene.objects.length).toBe(0)
  })

  it('creates box for visible furniture', () => {
    const home = createEmptyHome()
    home.furniture.push({
      id: 'f1', name: 'Chair',
      x: 200, y: 150, angleDeg: 45,
      width: 50, depth: 50, height: 90,
      elevation: 0, color: 0x8B4513,
    })
    const { scene } = buildRenderableScene(home)
    expect(scene.objects.length).toBe(1)
    expect(scene.objects[0]!.primitives[0]!.type).toBe('box')
  })

  it('maps camera from home observer', () => {
    const home = createEmptyHome()
    home.cameras.observer.x = 100
    home.cameras.observer.y = 200
    home.cameras.observer.z = 300
    home.cameras.observer.fovDeg = 50
    const { scene } = buildRenderableScene(home)
    expect(scene.camera.position).toEqual([100, 300, 200])
    expect(scene.camera.fov).toBe(50)
  })

  it('uses environment lightColor', () => {
    const home = createEmptyHome()
    home.environment.lightColor = 0xFF8800
    const { scene } = buildRenderableScene(home)
    expect(scene.lights[0]!.color).toBe(0xFF8800)
  })

  // ── Roof style geometry (roof-1-fix) ──────────────────────────

  it('gable roof produces 2 tilted panels', () => {
    const home = createEmptyHome()
    home.roofs.push({
      id: 'roof-g', points: [[0, 0], [400, 0], [400, 200], [0, 200]],
      style: 'gable', pitchDeg: 30, overhangCm: 20,
    })
    const { scene } = buildRenderableScene(home)
    const roof = scene.objects.find((o) => o.id === 'roof:roof-g')!
    expect(roof.primitives).toHaveLength(2)
    roof.primitives.forEach((p) => {
      expect(p.type).toBe('box')
      if (p.type === 'box') {
        expect(p.rotation[0] !== 0 || p.rotation[2] !== 0).toBe(true)
      }
    })
  })

  it('hip roof produces 4 tilted panels', () => {
    const home = createEmptyHome()
    home.roofs.push({
      id: 'roof-h', points: [[0, 0], [400, 0], [400, 200], [0, 200]],
      style: 'hip', pitchDeg: 30, overhangCm: 20,
    })
    const { scene } = buildRenderableScene(home)
    const roof = scene.objects.find((o) => o.id === 'roof:roof-h')!
    expect(roof.primitives).toHaveLength(4)
    roof.primitives.forEach((p) => {
      expect(p.type).toBe('box')
      if (p.type === 'box') {
        expect(p.rotation[0] !== 0 || p.rotation[2] !== 0).toBe(true)
      }
    })
  })

  it('shed roof produces 1 tilted panel covering full footprint', () => {
    const home = createEmptyHome()
    home.roofs.push({
      id: 'roof-s', points: [[0, 0], [400, 0], [400, 200], [0, 200]],
      style: 'shed', pitchDeg: 15, overhangCm: 10,
    })
    const { scene } = buildRenderableScene(home)
    const roof = scene.objects.find((o) => o.id === 'roof:roof-s')!
    expect(roof.primitives).toHaveLength(1)
    const p = roof.primitives[0]!
    expect(p.type).toBe('box')
    if (p.type === 'box') {
      expect(p.rotation[0] !== 0 || p.rotation[2] !== 0).toBe(true)
      expect(p.size[0]).toBe(420)
    }
  })

  it('flat roof produces 1 horizontal panel with no rotation', () => {
    const home = createEmptyHome()
    home.roofs.push({
      id: 'roof-f', points: [[0, 0], [400, 0], [400, 200], [0, 200]],
      style: 'flat', pitchDeg: 30, overhangCm: 20,
    })
    const { scene } = buildRenderableScene(home)
    const roof = scene.objects.find((o) => o.id === 'roof:roof-f')!
    expect(roof.primitives).toHaveLength(1)
    const p = roof.primitives[0]!
    expect(p.type).toBe('box')
    if (p.type === 'box') {
      expect(p.rotation).toEqual([0, 0, 0])
      expect(p.size[0]).toBe(440)
      expect(p.size[2]).toBe(240)
    }
  })

  it('overhang extends footprint for all roof styles', () => {
    const home = createEmptyHome()
    const pts: [number, number][] = [[0, 0], [300, 0], [300, 200], [0, 200]]
    for (const style of ['gable', 'hip', 'shed', 'flat'] as const) {
      home.roofs.push({ id: `roof-${style}`, points: pts, style, pitchDeg: 30, overhangCm: 50 })
    }
    const { scene } = buildRenderableScene(home)
    for (const style of ['gable', 'hip', 'shed', 'flat']) {
      const roof = scene.objects.find((o) => o.id === `roof:roof-${style}`)!
      const boxes = roof.primitives.filter((p) => p.type === 'box')
      expect(boxes.length).toBeGreaterThan(0)
      const anyBox = boxes[0]!
      expect(anyBox.type).toBe('box')
      if (anyBox.type === 'box') {
        const hasOverhangWidth = anyBox.size[0] >= 400
        const hasOverhangDepth = anyBox.size[2] >= 300
        expect(hasOverhangWidth || hasOverhangDepth).toBe(true)
      }
    }
  })

  // ── Wall opening segmentation (M27) ──────────────────────────

  it('keeps 2 boxes for wall with no openings (backward compat)', () => {
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
    })
    const { scene } = buildRenderableScene(home)
    const wallObj = scene.objects.find(o => o.id === 'wall:w1')!
    const boxes = wallObj.primitives.filter(p => p.type === 'box')
    expect(boxes.length).toBe(2)
  })

  it('segments wall into multiple boxes when a door opening is present', () => {
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
    })
    home.furniture.push({
      id: 'd1', name: 'Door',
      x: 200, y: 0, angleDeg: 0,
      width: 90, depth: 15, height: 210,
      elevation: 0,
      doorOrWindow: true, wallRef: 'w1', wallOffset: 200,
    })
    const { scene } = buildRenderableScene(home)
    const wallObj = scene.objects.find(o => o.id === 'wall:w1')!
    const boxes = wallObj.primitives.filter(p => p.type === 'box')
    // Door (elevation=0, top=210, wall height=250):
    // left segment 0-155 (2 boxes) + lintel 155-245/210-250 (2 boxes) + right segment 245-400 (2 boxes) = 6
    expect(boxes.length).toBeGreaterThan(2)
    expect(boxes.length).toBe(6)
  })

  it('produces sill and lintel boxes for window openings', () => {
    const home = createEmptyHome()
    home.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
    })
    home.furniture.push({
      id: 'win1', name: 'Window',
      x: 200, y: 0, angleDeg: 0,
      width: 120, depth: 15, height: 120,
      elevation: 90,
      doorOrWindow: true, wallRef: 'w1', wallOffset: 200,
    })
    const { scene } = buildRenderableScene(home)
    const wallObj = scene.objects.find(o => o.id === 'wall:w1')!
    const boxes = wallObj.primitives.filter(p => p.type === 'box')
    // Window (elevation=90, top=210, wall height=250):
    // left 0-140 (2) + sill 140-260/0-90 (2) + lintel 140-260/210-250 (2) + right 260-400 (2) = 8
    expect(boxes.length).toBe(8)
  })

  it('produces different geometry for wall with vs without opening', () => {
    const homeWithOpening = createEmptyHome()
    homeWithOpening.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
    })
    homeWithOpening.furniture.push({
      id: 'd1', name: 'Door',
      x: 200, y: 0, angleDeg: 0,
      width: 90, depth: 15, height: 210,
      elevation: 0,
      doorOrWindow: true, wallRef: 'w1', wallOffset: 200,
    })

    const homeWithout = createEmptyHome()
    homeWithout.walls.push({
      id: 'w1', xStart: 0, yStart: 0, xEnd: 400, yEnd: 0, thickness: 15,
    })

    const sceneWith = buildRenderableScene(homeWithOpening).scene
    const sceneWithout = buildRenderableScene(homeWithout).scene

    const boxesWith = sceneWith.objects.find(o => o.id === 'wall:w1')!.primitives.length
    const boxesWithout = sceneWithout.objects.find(o => o.id === 'wall:w1')!.primitives.length

    expect(boxesWith).toBeGreaterThan(boxesWithout)
  })
})
