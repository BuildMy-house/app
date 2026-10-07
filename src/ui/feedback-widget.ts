import { submitFeedback } from '../analytics/analytics'

export interface FeedbackWidgetOptions {
  /** Plan item counts attached to each submission so feedback is traceable. */
  getState: () => Record<string, number>
}

/**
 * Small unobtrusive "Feedback" button (bottom-right) that opens a text box +
 * optional email field. No login required; the submission is tagged with the
 * anonymous analytics session id and current plan item counts.
 */
export class FeedbackWidget {
  private readonly button: HTMLButtonElement
  private panel: HTMLFormElement | null = null

  constructor(private readonly parent: HTMLElement, private readonly options: FeedbackWidgetOptions) {
    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.id = 'feedback-btn'
    this.button.className = 'feedback-btn'
    this.button.textContent = 'Feedback'
    this.button.title = 'Send us feedback'
    this.button.addEventListener('click', () => (this.panel ? this.close() : this.open()))
    parent.appendChild(this.button)
  }

  private open(): void {
    const form = document.createElement('form')
    form.id = 'feedback-panel'
    form.className = 'feedback-panel'
    form.innerHTML = `
      <label for="feedback-message">What's on your mind?</label>
      <textarea id="feedback-message" name="message" rows="4" maxlength="2000" required placeholder="Bug, idea, or anything else…"></textarea>
      <label for="feedback-email">Email (optional, if you'd like a reply)</label>
      <input id="feedback-email" name="email" type="email" autocomplete="email" maxlength="200" />
      <div class="feedback-status" role="status"></div>
      <div class="feedback-actions">
        <button type="button" class="feedback-cancel">Cancel</button>
        <button type="submit" class="feedback-send">Send</button>
      </div>`
    form.querySelector('.feedback-cancel')!.addEventListener('click', () => this.close())
    form.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close() })
    form.addEventListener('submit', (e) => { e.preventDefault(); void this.send(form) })
    this.parent.appendChild(form)
    this.panel = form
    form.querySelector<HTMLTextAreaElement>('#feedback-message')!.focus()
  }

  private close(): void {
    this.panel?.remove()
    this.panel = null
  }

  private async send(form: HTMLFormElement): Promise<void> {
    const status = form.querySelector<HTMLDivElement>('.feedback-status')!
    const send = form.querySelector<HTMLButtonElement>('.feedback-send')!
    const message = form.querySelector<HTMLTextAreaElement>('#feedback-message')!.value.trim()
    const email = form.querySelector<HTMLInputElement>('#feedback-email')!.value.trim()
    if (!message) return
    send.disabled = true
    status.textContent = 'Sending…'
    const ok = await submitFeedback(message, email, this.options.getState())
    if (ok) {
      status.textContent = 'Thanks — feedback received!'
      setTimeout(() => this.close(), 1500)
    } else {
      status.textContent = 'Could not send — check your email address and connection, then retry.'
      send.disabled = false
    }
  }
}
