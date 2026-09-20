import { test, expect } from '@playwright/test'

async function boot(page: import('@playwright/test').Page) {
  await page.goto(process.env.HDRI_BASE_URL ?? '/')
  await page.waitForSelector('#view3d canvas', { timeout: 30_000 })
  await page.waitForFunction(() => (window as unknown as { __model?: unknown }).__model, {
    timeout: 30_000,
  })
  // applyEnvironment() intentionally skips the HDRI load on an empty home
  // (view.ts hasSceneContent guard, added in 229bd00 -- a blank-room HDRI
  // backdrop looked broken for marketing screenshots) -- an empty scene
  // never gets a texture background. Give the scene one piece of furniture
  // so the real content->HDRI path this test is actually verifying runs.
  await page.evaluate(() => {
    const store = (
      window as unknown as { __model: { getStore: () => { apply: (fn: (d: any) => void) => void } } }
    ).__model.getStore()
    store.apply((d: any) => {
      d.furniture = [
        {
          id: 'hdri-verify-probe',
          catalogId: 'chair-a',
          x: 0,
          y: 0,
          angleDeg: 0,
          width: 40,
          height: 80,
          depth: 40,
          elevation: 0,
          visible: true,
        },
      ]
    })
  })
  // HDRI load is async — wait until background is a Texture (not the flat Color).
  await page.waitForFunction(
    () => {
      const v = (window as unknown as { __view3d?: { _scene?: { background?: { isTexture?: boolean } } } }).__view3d
      return !!v?._scene?.background?.isTexture
    },
    { timeout: 15_000 },
  )
}

function envState(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const v = (window as unknown as {
      __view3d?: {
        _scene?: {
          background?: { uuid: string; isTexture?: boolean }
          environment?: { uuid: string } | null
          traverse?: (cb: (o: { isHemisphereLight?: boolean; intensity?: number }) => void) => void
        }
        getEnvironmentPreset?: () => string
      }
    }).__view3d
    const scene = v!._scene!
    let hemi: number | undefined
    scene.traverse?.((o) => {
      if (o.isHemisphereLight) hemi = o.intensity
    })
    return {
      preset: v!.getEnvironmentPreset?.(),
      bgIsTexture: !!scene.background?.isTexture,
      bgUuid: scene.background?.uuid,
      envMatchesBg: !!scene.environment && scene.environment.uuid === scene.background?.uuid,
      hemi,
    }
  })
}

test('HDRI environment: presets change background + lighting', async ({ page }) => {
  await boot(page)
  const studio = await envState(page)
  expect(studio.preset).toBe('studio')
  expect(studio.bgIsTexture).toBe(true)
  expect(studio.envMatchesBg).toBe(true)
  // Flat lights dimmed for IBL (buildScene sets hemi=1.0; env-active dims to 0.35).
  expect(studio.hemi).toBeCloseTo(0.35)
  await page.screenshot({ path: 'test-results/hdri-studio.png' })

  await page.evaluate(() =>
    (window as unknown as { __view3d: { setEnvironmentPreset: (id: string) => void } }).__view3d
      .setEnvironmentPreset('daylight'),
  )
  await page.waitForFunction(
    () =>
      (window as unknown as { __view3d?: { getEnvironmentPreset?: () => string } }).__view3d
        ?.getEnvironmentPreset?.() === 'daylight',
  )
  const daylight = await envState(page)
  expect(daylight.preset).toBe('daylight')
  expect(daylight.bgUuid).not.toEqual(studio.bgUuid) // different HDRI texture
  expect(daylight.envMatchesBg).toBe(true)
  await page.screenshot({ path: 'test-results/hdri-daylight.png' })

  await page.evaluate(() =>
    (window as unknown as { __view3d: { setEnvironmentPreset: (id: string) => void } }).__view3d
      .setEnvironmentPreset('overcast'),
  )
  await page.waitForFunction(
    () =>
      (window as unknown as { __view3d?: { getEnvironmentPreset?: () => string } }).__view3d
        ?.getEnvironmentPreset?.() === 'overcast',
  )
  const overcast = await envState(page)
  expect(overcast.preset).toBe('overcast')
  expect(overcast.bgUuid).not.toEqual(daylight.bgUuid)
  await page.screenshot({ path: 'test-results/hdri-overcast.png' })

  // Persisted viewport pref.
  expect(await page.evaluate(() => localStorage.getItem('homely-hdri-preset'))).toBe('overcast')
})

test('View menu lists environment presets', async ({ page }) => {
  await boot(page)
  // Menus render as DOM buttons; check the menu bar contains the entries.
  const viewMenu = page.locator('.menu-trigger').nth(2)
  await viewMenu.click()
  await page.waitForTimeout(300)
  const text = await page.evaluate(() => document.body.innerText)
  expect(text).toContain('Environment: Studio')
  expect(text).toContain('Environment: Daylight')
  expect(text).toContain('Environment: Overcast')
})
