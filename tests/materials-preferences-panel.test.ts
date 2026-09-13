// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { HomeStore } from '../src/core/store'
import { MaterialsPreferencesPanel } from '../src/ui/MaterialsPreferencesPanel'

describe('MaterialsPreferencesPanel', () => {
  it('renders current home defaults', () => {
    const store = new HomeStore()
    const panel = new MaterialsPreferencesPanel(store)
    const el = document.createElement('div')
    panel.render(el)
    expect(el.querySelector<HTMLInputElement>('#mat-floor-color')!.value).toBe('#f0f0f0')
    expect(el.querySelector<HTMLInputElement>('#mat-floor-shininess')!.value).toBe('0')
    expect(el.querySelector<HTMLInputElement>('#mat-ceiling-color')!.value).toBe('#ffffff')
    expect(el.querySelector<HTMLInputElement>('#mat-ceiling-visible')!.checked).toBe(true)
  })

  it('apply() writes edited values into home preferences', () => {
    const store = new HomeStore()
    const panel = new MaterialsPreferencesPanel(store)
    const el = document.createElement('div')
    panel.render(el)

    const floor = el.querySelector<HTMLInputElement>('#mat-floor-color')!
    floor.value = '#ff8800'
    floor.dispatchEvent(new Event('input'))
    const vis = el.querySelector<HTMLInputElement>('#mat-ceiling-visible')!
    vis.checked = false
    vis.dispatchEvent(new Event('change'))

    panel.apply()
    const prefs = store.getHome().preferences!
    expect(prefs.defaultFloorColor).toBe(0xff8800)
    expect(prefs.defaultCeilingVisibility).toBe(false)
    expect(prefs.defaultCeilingColor).toBe(0xffffff)
  })

  it('reset() restores built-in defaults', () => {
    const store = new HomeStore()
    const panel = new MaterialsPreferencesPanel(store)
    const el = document.createElement('div')
    panel.render(el)
    const vis = el.querySelector<HTMLInputElement>('#mat-ceiling-visible')!
    vis.checked = false
    vis.dispatchEvent(new Event('change'))
    panel.apply()
    expect(store.getHome().preferences!.defaultCeilingVisibility).toBe(false)

    panel.reset()
    const el2 = document.createElement('div')
    panel.render(el2)
    expect(el2.querySelector<HTMLInputElement>('#mat-ceiling-visible')!.checked).toBe(true)
  })
})
