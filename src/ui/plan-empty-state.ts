/**
 * First-run guidance shown over the plan canvas while the document is empty
 * (no walls, rooms, or furniture). A short progressive checklist shows the
 * whole arc of building a first house; hidden as soon as anything exists
 * (or once dismissed). Dismissal and completion stick for the session.
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
    <style>
      .plan-empty-state .plan-empty-steps {
        list-style: none;
        margin: 0 0 12px;
        padding: 0;
        text-align: left;
      }
      .plan-empty-state .plan-empty-step {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 6px 0;
        font-size: 13px;
      }
      .plan-empty-state .plan-empty-step + .plan-empty-step {
        border-top: 1px solid var(--border);
      }
      .plan-empty-state .plan-step-marker {
        flex: none;
        width: 20px;
        height: 20px;
        margin-top: 1px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        border: 1px solid var(--border);
        font-size: 11px;
        color: var(--text-secondary);
      }
      .plan-empty-state .plan-step-marker::before { content: attr(data-n); }
      .plan-empty-state .plan-empty-step.done .plan-step-marker {
        background: var(--accent, #2f81f7);
        border-color: var(--accent, #2f81f7);
        color: #fff;
      }
      .plan-empty-state .plan-empty-step.done .plan-step-marker::before { content: '✓'; }
      .plan-empty-state .plan-empty-step.done .plan-step-body {
        text-decoration: line-through;
        opacity: 0.6;
      }
      .plan-empty-state .plan-step-body { flex: 1; }
      .plan-empty-state .plan-step-title { font-weight: 600; }
      .plan-empty-state .plan-step-hint {
        display: block;
        margin-top: 2px;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .plan-empty-state .plan-empty-primary {
        margin-top: 6px;
        padding: 6px 12px;
        border-radius: 6px;
        cursor: pointer;
        border: 1px solid var(--accent, #2f81f7);
        background: var(--accent, #2f81f7);
        color: #fff;
        pointer-events: auto;
      }
      .plan-empty-state .plan-empty-secondary {
        width: 100%;
        padding: 8px 12px;
        border-radius: 6px;
        cursor: pointer;
        border: 1px solid var(--border);
        background: transparent;
        color: inherit;
        pointer-events: auto;
      }
      .plan-empty-state .plan-empty-dismiss {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--text-secondary);
        font-size: 14px;
        cursor: pointer;
        pointer-events: auto;
      }
      .plan-empty-state .plan-empty-dismiss:hover { color: inherit; }
    </style>
    <button type="button" class="plan-empty-dismiss" title="Dismiss getting-started steps" aria-label="Dismiss getting-started steps">✕</button>
    <h2>Build your first house</h2>
    <ol class="plan-empty-steps">
      <li class="plan-empty-step" data-step="1">
        <span class="plan-step-marker" data-n="1" aria-hidden="true"></span>
        <div class="plan-step-body">
          <span class="plan-step-title">Draw your first walls</span>
          <span class="plan-step-hint">Pick up the Wall tool, then click points on the canvas.</span>
          <button type="button" class="plan-empty-primary">Draw your first walls</button>
        </div>
      </li>
      <li class="plan-empty-step" data-step="2">
        <span class="plan-step-marker" data-n="2" aria-hidden="true"></span>
        <div class="plan-step-body">
          <span class="plan-step-title">Add a door or window</span>
          <span class="plan-step-hint">Open the Furniture sidebar and pick the Doors or Windows category.</span>
        </div>
      </li>
      <li class="plan-empty-step" data-step="3">
        <span class="plan-step-marker" data-n="3" aria-hidden="true"></span>
        <div class="plan-step-body">
          <span class="plan-step-title">Furnish a room</span>
          <span class="plan-step-hint">Choose any catalog piece, then click your plan to place it.</span>
        </div>
      </li>
      <li class="plan-empty-step" data-step="4">
        <span class="plan-step-marker" data-n="4" aria-hidden="true"></span>
        <div class="plan-step-body">
          <span class="plan-step-title">See your house in 3D</span>
          <span class="plan-step-hint">Use the View menu → 3D View to look around inside.</span>
        </div>
      </li>
    </ol>
    <button type="button" class="plan-empty-secondary"></button>
    <p class="plan-empty-hint">Tip: use File → Save to keep your work.</p>
  `

  const steps = Array.from(element.querySelectorAll<HTMLLIElement>('.plan-empty-step'))
  const markDone = (index: number): void => {
    steps[index]?.classList.add('done')
  }
  const secondary = element.querySelector<HTMLButtonElement>('.plan-empty-secondary')!
  element.querySelector('.plan-empty-primary')!.addEventListener('click', () => {
    markDone(0)
    actions.onDrawWalls()
  })
  secondary.addEventListener('click', () => actions.onOpenProjects())

  let dismissed = false
  element.querySelector('.plan-empty-dismiss')!.addEventListener('click', () => {
    dismissed = true
    element.hidden = true
  })

  const setSignedIn = (signedIn: boolean): void => {
    secondary.textContent = signedIn ? 'Open a saved project' : 'Log in to open saved projects'
  }
  setSignedIn(false)

  let shown = false
  return {
    element,
    setEmpty(empty) {
      if (dismissed) return
      if (!empty) markDone(0) // first geometry exists → step 1 done
      if (empty === shown) return
      shown = empty
      element.hidden = !empty
    },
    setSignedIn,
  }
}
