// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { showToast } from '../src/ui/toast'
import { createPlanEmptyState } from '../src/ui/plan-empty-state'
import { HomeListDialog } from '../src/ui/home-list-dialog'

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('toast', () => {
  it('success auto-dismisses; error persists until dismissed', () => {
    vi.useFakeTimers()
    const ok = showToast('success', 'Saved')
    const bad = showToast('error', 'Failed', 'because')
    expect(ok.getAttribute('role')).toBe('status')
    expect(bad.getAttribute('role')).toBe('alert')
    vi.advanceTimersByTime(5000)
    expect(ok.isConnected).toBe(false)
    expect(bad.isConnected).toBe(true)
    bad.querySelector<HTMLButtonElement>('.toast-close')!.click()
    expect(bad.isConnected).toBe(false)
  })
})

describe('plan empty state', () => {
  it('shows only while empty and exposes next actions', () => {
    const onDrawWalls = vi.fn()
    const onOpenProjects = vi.fn()
    const es = createPlanEmptyState({ onDrawWalls, onOpenProjects })
    document.body.appendChild(es.element)
    expect(es.element.hidden).toBe(true)
    es.setEmpty(true)
    expect(es.element.hidden).toBe(false)
    es.element.querySelector<HTMLButtonElement>('.plan-empty-primary')!.click()
    es.element.querySelector<HTMLButtonElement>('.plan-empty-secondary')!.click()
    expect(onDrawWalls).toHaveBeenCalled()
    expect(onOpenProjects).toHaveBeenCalled()
    es.setEmpty(false)
    expect(es.element.hidden).toBe(true)
  })

  it('secondary action wording follows sign-in state', () => {
    const es = createPlanEmptyState({ onDrawWalls: vi.fn(), onOpenProjects: vi.fn() })
    const btn = es.element.querySelector('.plan-empty-secondary')!
    expect(btn.textContent).toContain('Log in')
    es.setSignedIn(true)
    expect(btn.textContent).toContain('Open a saved project')
  })

  it('shows the full onboarding checklist while empty', () => {
    const es = createPlanEmptyState({ onDrawWalls: vi.fn(), onOpenProjects: vi.fn() })
    document.body.appendChild(es.element)
    es.setEmpty(true)
    const steps = es.element.querySelectorAll('.plan-empty-step')
    expect(steps.length).toBe(4)
    expect(es.element.textContent).toContain('Draw your first walls')
    expect(es.element.textContent).toContain('Add a door or window')
    expect(es.element.textContent).toContain('Furnish a room')
    expect(es.element.textContent).toContain('See your house in 3D')
    expect(es.element.querySelector('.plan-empty-step.done')).toBeNull()
  })

  it('marks step 1 done once the plan has content, then hides', () => {
    const es = createPlanEmptyState({ onDrawWalls: vi.fn(), onOpenProjects: vi.fn() })
    es.setEmpty(true)
    expect(es.element.querySelector('.plan-empty-step.done')).toBeNull()
    es.setEmpty(false)
    expect(es.element.querySelector('.plan-empty-step[data-step="1"]')!.classList.contains('done')).toBe(true)
    expect(es.element.hidden).toBe(true)
  })

  it('dismissal hides the checklist permanently', () => {
    const es = createPlanEmptyState({ onDrawWalls: vi.fn(), onOpenProjects: vi.fn() })
    es.setEmpty(true)
    es.element.querySelector<HTMLButtonElement>('.plan-empty-dismiss')!.click()
    expect(es.element.hidden).toBe(true)
    es.setEmpty(true)
    expect(es.element.hidden).toBe(true)
  })
})

describe('My Projects empty state', () => {
  it('explains and offers saving the current project', () => {
    const onSaveCurrent = vi.fn()
    new HomeListDialog([], { onPick: vi.fn(), onSaveCurrent }).open()
    expect(document.body.textContent).toContain('No saved projects yet')
    document.querySelector<HTMLButtonElement>('.home-list-empty-cta')!.click()
    expect(onSaveCurrent).toHaveBeenCalled()
    expect(document.querySelector('.home-list-dialog')).toBeNull()
  })
})
