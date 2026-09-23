import { test, expect } from '@playwright/test'

// Probe for the "closed rooms are back" production report: does a deleted
// room resurrect after a reload via the local-draft autosave slot?
test('deleted room does not resurrect after reload (local draft)', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => (window as any).__model, null, { timeout: 10_000 })

  // Start from a clean slate: drop any draft from a previous session and boot
  // again so the default-document path runs.
  await page.evaluate(() => localStorage.removeItem('homely-local-draft'))
  await page.reload()
  await page.waitForFunction(() => (window as any).__model, null, { timeout: 10_000 })

  const levelId = await page.evaluate(() => {
    const model = (window as any).__model
    const home = model.getStore().getHome()
    if (home.levels.length === 0)
      model.addLevel({ name: 'Ground', elevation: 0, floorThickness: 5, height: 250, visible: true, viewable: true })
    return model.getStore().getHome().levels[0].id
  })

  await page.evaluate((lvl) => {
    ;(window as any).__model.addRoom(
      [[0, 0], [400, 0], [400, 200], [0, 200]],
      { levelRef: lvl },
    )
  }, levelId)

  const afterAdd = await page.evaluate(
    () => (window as any).__model.getStore().getHome().rooms.length,
  )
  expect(afterAdd).toBe(1)

  // Let the 2s draft interval persist the added room before deleting.
  await page.waitForTimeout(2500)

  await page.evaluate(() => {
    const home = (window as any).__model.getStore().getHome()
    ;(window as any).__model.removeRoom(home.rooms[0].id)
  })
  const afterDelete = await page.evaluate(
    () => (window as any).__model.getStore().getHome().rooms.length,
  )
  expect(afterDelete).toBe(0)

  // Let the draft interval persist the deletion, then hard-reload (the
  // beforeunload handler also saves, mirroring a real refresh).
  await page.waitForTimeout(2500)
  const draftRooms = await page.evaluate(() => {
    const raw = localStorage.getItem('homely-local-draft')
    return raw ? (JSON.parse(raw).rooms?.length ?? 0) : -1
  })
  expect(draftRooms).toBe(0)

  await page.reload()
  await page.waitForFunction(() => (window as any).__model, null, { timeout: 10_000 })
  const afterReload = await page.evaluate(
    () => (window as any).__model.getStore().getHome().rooms.length,
  )
  expect(afterReload).toBe(0)
})
