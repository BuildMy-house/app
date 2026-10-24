// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createPlanEmptyState } from './plan-empty-state'

const actions = { onDrawWalls: vi.fn(), onOpenProjects: vi.fn() }

describe('createPlanEmptyState sign-in wording', () => {
  it('starts signed out with a tip that flags sign-in for account saves', () => {
    const state = createPlanEmptyState(actions)

    expect(state.element.querySelector('.plan-empty-secondary')!.textContent).toBe('Log in to open saved projects')
    expect(state.element.querySelector('.plan-empty-hint')!.textContent).toMatch(/sign in first/)
  })

  it('keeps the original local-save tip once signed in', () => {
    const state = createPlanEmptyState(actions)
    state.setSignedIn(true)

    expect(state.element.querySelector('.plan-empty-secondary')!.textContent).toBe('Open a saved project')
    const hint = state.element.querySelector('.plan-empty-hint')!.textContent!
    expect(hint).toBe('Tip: use File → Save to keep your work.')
    expect(hint).not.toMatch(/sign in/i)
  })

  it('flips the tip back when the user logs out again', () => {
    const state = createPlanEmptyState(actions)
    state.setSignedIn(true)
    state.setSignedIn(false)

    expect(state.element.querySelector('.plan-empty-hint')!.textContent).toMatch(/sign in first/)
  })
})
