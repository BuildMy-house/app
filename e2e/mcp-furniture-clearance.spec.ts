import { expect, test, type Page } from '@playwright/test'
import { McpStdioServer, mcpPython, type ToolResult } from './helpers/mcp-stdio'

/**
 * The real thing end to end: the Python MCP server (stdio JSON-RPC), the real app in
 * Chromium connected to it over the automation WebSocket, and the same tool calls an
 * agent makes. Asserts the furniture rules hold on every path an agent has:
 * oversize pieces come back as the structured FURNITURE_TOO_LARGE error and change
 * nothing; pieces that touch a wall are moved flush against it.
 *
 * Needs a Python with the MCP packages (HOMELY_MCP_PYTHON, or mcp/.venv); skipped
 * where there is none.
 */
const python = mcpPython()
test.skip(!python, 'no Python with the MCP packages (set HOMELY_MCP_PYTHON or create mcp/.venv)')

const SOFA = 'sh3d-full#PeterSmolik#sofa1' // 234 x 79.37 cm
const CORNERS = [[0, 0], [400, 0], [400, 400], [0, 400]]
const WALLS = CORNERS.map(([xs, ys], i) => {
  const [xe, ye] = CORNERS[(i + 1) % 4]!
  return { key: `w${i + 1}`, xStart: xs, yStart: ys, xEnd: xe, yEnd: ye, thickness: 10 }
})
const LIVING = { walls: WALLS, rooms: [{ name: 'Living', points: CORNERS }] }

let mcp: McpStdioServer

test.beforeEach(async ({ page }) => {
  mcp = await McpStdioServer.start(python!)
  // In stdio mode homely_status is what opens the automation socket, so it comes before the app launches.
  await mcp.call('homely_status')
  await page.goto(`/?automationPort=${mcp.automationPort}`)
  await page.waitForSelector('.catalog-card', { timeout: 15_000 })
  await expect.poll(async () => ((await mcp.call('homely_status')).json as { connected: string[] }).connected, { timeout: 15_000 }).toContain('homely')
})

test.afterEach(() => mcp.stop())

const state = async (): Promise<Record<string, any>> => (await mcp.call('get_home_state')).json as Record<string, any>

function expectTooLarge(res: ToolResult, fragment: string): void {
  expect(res.isError).toBe(true)
  expect(res.text).toContain('FURNITURE_TOO_LARGE')
  expect(res.text).toContain(fragment)
}

async function expectUntouched(page: Page, before: Record<string, any>): Promise<void> {
  const after = await state()
  expect(after).toEqual(before)
  await expect(page.locator('.toast-error')).toHaveCount(0)
}

test('add_furniture: an oversize piece is a structured error that changes nothing; a wall-touching piece lands flush', async ({ page }) => {
  expect((await mcp.call('build_house', { plan: { walls: WALLS.map((w) => ({ ...w, xEnd: w.xEnd / 4, yEnd: w.yEnd / 4, xStart: w.xStart / 4, yStart: w.yStart / 4 })), rooms: [{ name: 'Closet', points: CORNERS.map(([x, y]) => [x / 4, y / 4]) }] } })).isError).toBe(false)
  const before = await state()
  expectTooLarge(await mcp.call('add_furniture', { catalog_id: SOFA, x: 50, y: 50 }), 'too large for room "Closet"')
  await expectUntouched(page, before)

  await mcp.call('build_house', { plan: LIVING })
  const placed = await mcp.call('add_furniture', { catalog_id: SOFA, x: 200, y: 2 })
  expect(placed.isError).toBe(false)
  const sofa = (await state()).furniture[0]
  expect(sofa.y).toBeCloseTo(5 + 79.37 / 2, 1)
  expect(((await mcp.call('validate_scene')).json as { valid: boolean }).valid).toBe(true)
})

test('modify_selected: growing a piece past its room is rejected untouched; moving it into a wall is pushed out', async ({ page }) => {
  const built = (await mcp.call('build_house', { plan: { ...LIVING, furniture: [{ key: 'desk', name: 'Desk', x: 200, y: 200, width: 120, depth: 60, height: 75 }] } })).json as { furnitureIds: { desk: string } }
  await mcp.call('select_object', { object_id: built.furnitureIds.desk })
  const before = await state()
  expectTooLarge(await mcp.call('modify_selected', { props: { width: 900 } }), '"Desk" (900 x 60 cm) is too large for room "Living"')
  await expectUntouched(page, before)

  expect((await mcp.call('modify_selected', { props: { x: 1, y: 1 } })).isError).toBe(false)
  const desk = (await state()).furniture[0]
  expect(desk.x).toBeCloseTo(5 + 60, 1)
  expect(desk.y).toBeCloseTo(5 + 30, 1)
})

test('build_house: an oversize piece rejects the whole build and leaves the existing home as it was; a wall-touching piece is pushed flush', async ({ page }) => {
  await mcp.call('build_house', { plan: { ...LIVING, furniture: [{ name: 'Desk', x: 200, y: 200, width: 120, depth: 60, height: 75 }] } })
  const before = await state()
  const rejected = await mcp.call('build_house', {
    plan: { walls: WALLS, rooms: [{ name: 'Study', points: CORNERS }], furniture: [{ name: 'Sofa', x: 200, y: 200, width: 500, depth: 90, height: 80 }] },
  })
  expectTooLarge(rejected, '"Sofa" (500 x 90 cm) is too large for room "Study"')
  await expectUntouched(page, before)

  const built = await mcp.call('build_house', { plan: { ...LIVING, furniture: [{ name: 'Desk', x: 200, y: 3, width: 120, depth: 60, height: 75 }] } })
  expect(built.isError).toBe(false)
  expect((await state()).furniture[0].y).toBeCloseTo(35, 1)
  expect(((await mcp.call('validate_scene')).json as { valid: boolean }).valid).toBe(true)
})
