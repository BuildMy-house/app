/**
 * First-run guidance shown over the plan canvas while the document is empty
 * (no walls, rooms, or furniture). Explains what to do and exposes the next
 * actions; hidden as soon as anything exists.
 */

export interface PlanEmptyStateActions {
  onDrawWalls: () => void
  onOpenProjects: () => void
}

export interface PlanEmptyState {
  element: HTMLDivElement
  /** Show when `empty`, hide otherwise. Cheap to call every frame. */
  setEmpty(empty: boolean): void
  /** Reflect sign-in state in the secondary action's wording. */
  setSignedIn(signedIn: boolean): void
}

export function createPlanEmptyState(actions: PlanEmptyStateActions): PlanEmptyState {
  const element = document.createElement('div')
  element.className = 'plan-empty-state'
  element.hidden = true
  element.innerHTML = `
    <h2>Start your floor plan</h2>
    <p>Your plan is empty. Draw walls to outline your space, then add rooms and furniture from the catalog.</p>
    <div class="plan-empty-actions">
      <button type="button" class="plan-empty-primary">Draw your first walls</button>
      <button type="button" class="plan-empty-secondary"></button>
    </div>
    <p class="plan-empty-hint">Tip: use File → Save to keep your work.</p>
  `
  const secondary = element.querySelector<HTMLButtonElement>('.plan-empty-secondary')!
  element.querySelector('.plan-empty-primary')!.addEventListener('click', () => actions.onDrawWalls())
  secondary.addEventListener('click', () => actions.onOpenProjects())

  const setSignedIn = (signedIn: boolean): void => {
    secondary.textContent = signedIn ? 'Open a saved project' : 'Log in to open saved projects'
  }
  setSignedIn(false)

  let shown = false
  return {
    element,
    setEmpty(empty) {
      if (empty === shown) return
      shown = empty
      element.hidden = !empty
    },
    setSignedIn,
  }
}
