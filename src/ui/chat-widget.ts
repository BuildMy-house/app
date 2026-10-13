/**
 * Floating PM-agent chat widget (ticket A1).
 *
 * Ships behind a feature flag with a fully injectable backend: the pm-agent
 * HTTP surface does not exist yet, so no live endpoint is wired here.
 * Production wiring to a real `pm-agent.buildmy.house` endpoint is a separate
 * ticket (A2) that is not yet built — do not point this at one before then.
 *
 * Every outgoing message carries the real logged-in user's id (the `sub`
 * claim of the stored auth JWT, the same id `requireAuth` derives
 * server-side). Without one the widget refuses to send rather than falling
 * back to an anonymous/placeholder id.
 */

/**
 * PM-agent flag — mirrors `src/config/feature-flags.ts`: a `VITE_` env var
 * read at build time, enabled only when exactly 'true' (default OFF). This
 * repo deploys to prod automatically on push to main, so the widget must
 * never default on.
 */
export function isPmAgentChatEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_PM_AGENT_CHAT === 'true'
}

/** One message on its way to the pm-agent backend. */
export interface OutgoingChatMessage {
  /** Real logged-in user's id (auth JWT `sub`). Never null/placeholder. */
  userId: string
  /** User-typed text. */
  text: string
}

/**
 * Backend seam: the widget only ever talks to this, so tests inject a mock
 * and A2 can swap in the real proxy without touching the UI.
 */
export interface PmAgentClient {
  /**
   * Sends one user message. Resolves with the reply text, or with a queue
   * ticket when the (single-user-at-a-time) agent is busy and the answer must
   * be fetched with `poll`.
   */
  send(message: OutgoingChatMessage): Promise<string | QueuedChat>
  /** Checks a queue ticket; required whenever `send` can return a ticket. */
  poll?(ticket: string): Promise<ChatPollResult>
}

/** The agent is busy: the message is waiting (or running) under this ticket. */
export interface QueuedChat {
  ticket: string
  /** 1-based place in the queue; 0 when the message is already being answered. */
  position: number
}

export type ChatPollResult =
  | { status: 'queued'; position: number }
  | { status: 'processing' }
  | { status: 'done'; reply: string }
  | { status: 'expired' }

/** How often a queued message checks its place. */
export const QUEUE_POLL_INTERVAL_MS = 3000
const MAX_CONSECUTIVE_POLL_FAILURES = 3

export interface ChatWidgetOptions {
  client: PmAgentClient
  /** Queue poll interval; defaults to QUEUE_POLL_INTERVAL_MS. */
  pollIntervalMs?: number
  /** Real logged-in user's id, or null when signed out. */
  getUserId: () => string | null
}

/**
 * Simple fetch client for the pm-agent chat round-trip (POST out, JSON
 * `{ reply }` back). `endpoint` is injected — nothing here hardcodes a URL.
 * Endpoint path for the real backend lands with A2.
 */
export function createFetchPmAgentClient(
  fetchImpl: typeof fetch,
  endpoint: string,
  getToken: () => string | null = () => null,
): PmAgentClient {
  // /api/chat sits behind requireAuth, which needs the session JWT as a bearer token.
  const authHeaders = (): Record<string, string> => {
    const token = getToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }
  return {
    async send({ userId, text }): Promise<string | QueuedChat> {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ userId, message: text }),
      })
      if (!response.ok) throw new Error(`chat request failed (${response.status})`)
      const data = (await response.json()) as { status?: unknown; ticket?: unknown; position?: unknown; reply?: unknown }
      if ((data.status === 'queued' || data.status === 'processing') && typeof data.ticket === 'string') {
        return { ticket: data.ticket, position: data.status === 'queued' && typeof data.position === 'number' ? data.position : 0 }
      }
      if (typeof data.reply !== 'string') throw new Error('chat reply missing')
      return data.reply
    },
    async poll(ticket): Promise<ChatPollResult> {
      const response = await fetchImpl(`${endpoint}/status?ticket=${encodeURIComponent(ticket)}`, {
        headers: authHeaders(),
      })
      if (!response.ok) throw new Error(`chat status failed (${response.status})`)
      const data = (await response.json()) as { status?: unknown; position?: unknown; reply?: unknown }
      if (data.status === 'queued' && typeof data.position === 'number') return { status: 'queued', position: data.position }
      if (data.status === 'processing') return { status: 'processing' }
      if (data.status === 'done' && typeof data.reply === 'string') return { status: 'done', reply: data.reply }
      if (data.status === 'expired') return { status: 'expired' }
      throw new Error('chat status invalid')
    },
  }
}

/**
 * Real user id from the stored auth session JWT (`server/src/auth.ts` signs
 * it with `subject: userId`, so the `sub` claim is the user's UUID). Returns
 * null for a missing/malformed token — callers must treat null as "not
 * signed in", never as a usable id.
 */
export function userIdFromToken(token: string | null): string | null {
  if (!token) return null
  const parts = token.split('.')
  const payload = parts[1]
  if (!payload) return null
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const sub = (JSON.parse(json) as { sub?: unknown }).sub
    return typeof sub === 'string' && sub ? sub : null
  } catch {
    return null
  }
}

/**
 * Floating chat panel: open/close toggle button, message list, text input +
 * send button. Returns the root element for the caller to append.
 */
export function createChatWidget(options: ChatWidgetOptions): HTMLDivElement {
  const element = document.createElement('div')
  element.className = 'chat-widget'
  element.innerHTML = `
    <style>
      .chat-widget {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 1000;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        font-size: 13px;
        color: var(--text);
      }
      .chat-widget .chat-panel {
        display: flex;
        flex-direction: column;
        width: 320px;
        height: 400px;
        background: var(--panel-bg);
        border: 1px solid var(--border);
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        overflow: hidden;
        pointer-events: auto;
      }
      .chat-widget .chat-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 10px;
        border-bottom: 1px solid var(--border);
        font-weight: 600;
      }
      .chat-widget .chat-close {
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-size: 14px;
        cursor: pointer;
        padding: 0 4px;
      }
      .chat-widget .chat-messages {
        flex: 1;
        overflow-y: auto;
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .chat-widget .chat-msg {
        max-width: 85%;
        padding: 6px 8px;
        border-radius: 8px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .chat-widget .chat-msg.user {
        align-self: flex-end;
        background: var(--accent, #2f81f7);
        color: #fff;
      }
      .chat-widget .chat-msg.agent {
        align-self: flex-start;
        background: var(--toolbar-bg);
        border: 1px solid var(--border);
      }
      .chat-widget .chat-error {
        margin: 0;
        padding: 6px 10px;
        border-top: 1px solid var(--border);
        color: #d13c3c;
        font-size: 12px;
      }
      .chat-widget .chat-composer {
        display: flex;
        gap: 6px;
        padding: 8px 10px;
        border-top: 1px solid var(--border);
      }
      .chat-widget .chat-input {
        flex: 1;
        min-width: 0;
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--bg);
        color: inherit;
        font: inherit;
      }
      .chat-widget .chat-send {
        padding: 6px 12px;
        border: 1px solid var(--accent, #2f81f7);
        border-radius: 6px;
        background: var(--accent, #2f81f7);
        color: #fff;
        cursor: pointer;
        font: inherit;
      }
      .chat-widget .chat-toggle {
        width: 44px;
        height: 44px;
        border: 1px solid var(--border);
        border-radius: 50%;
        background: var(--panel-bg);
        color: var(--text);
        font-size: 18px;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        pointer-events: auto;
      }
    </style>
    <div class="chat-panel" hidden>
      <div class="chat-header">
        <span>PM agent</span>
        <button type="button" class="chat-close" aria-label="Close chat">✕</button>
      </div>
      <div class="chat-messages" role="log" aria-live="polite"></div>
      <p class="chat-error" role="alert" hidden></p>
      <div class="chat-composer">
        <input type="text" class="chat-input" placeholder="Message the PM agent…" aria-label="Chat message" />
        <button type="button" class="chat-send">Send</button>
      </div>
    </div>
    <button type="button" class="chat-toggle" aria-expanded="false" aria-label="Open chat" title="Open PM agent chat">💬</button>
  `

  const panel = element.querySelector<HTMLDivElement>('.chat-panel')!
  const toggle = element.querySelector<HTMLButtonElement>('.chat-toggle')!
  const input = element.querySelector<HTMLInputElement>('.chat-input')!
  const messages = element.querySelector<HTMLDivElement>('.chat-messages')!
  const error = element.querySelector<HTMLParagraphElement>('.chat-error')!

  const showError = (text: string): void => {
    error.textContent = text
    error.hidden = false
  }

  const appendMessage = (role: 'user' | 'agent', text: string): void => {
    const line = document.createElement('div')
    line.className = `chat-msg ${role}`
    line.textContent = text
    messages.appendChild(line)
    messages.scrollTop = messages.scrollHeight
  }

  const send = (): void => {
    const text = input.value.trim()
    if (!text) return
    const userId = options.getUserId()
    // No real logged-in user id → refuse to send. Never ship an anonymous
    // or placeholder id to the pm-agent.
    if (!userId) {
      showError('Sign in to chat — no logged-in user id, message not sent.')
      return
    }
    if (queueWait) {
      showError('Please wait for your turn before sending another message.')
      return
    }
    error.hidden = true
    input.value = ''
    appendMessage('user', text)
    // Replies can take up to ~60s (model reasoning + tool calls): show it.
    const thinking = showThinking()
    void options.client.send({ userId, text }).then(
      (result) => {
        thinking.remove()
        if (typeof result === 'string') {
          appendMessage('agent', result)
        } else if (!panel.hidden) {
          waitInQueue(result)
        }
      },
      (err: unknown) => {
        thinking.remove()
        showError(err instanceof Error ? err.message : 'chat request failed')
      },
    )
  }

  const showThinking = (): HTMLDivElement => {
    const thinking = document.createElement('div')
    thinking.className = 'chat-thinking'
    thinking.style.cssText = 'font-style: italic; opacity: 0.7;'
    thinking.setAttribute('role', 'status')
    thinking.textContent = 'PM agent is thinking…'
    messages.appendChild(thinking)
    messages.scrollTop = messages.scrollHeight
    return thinking
  }

  const queueText = (position: number): string =>
    position <= 1
      ? "You're next — our support agent is finishing with another user."
      : `Our support agent is busy helping another user. You're number ${position} in the queue.`

  /** Active queue wait: its poll timer and the status line it owns. */
  let queueWait: { timer: ReturnType<typeof setTimeout> | undefined; line: HTMLDivElement } | null = null

  const stopQueueWait = (): void => {
    if (!queueWait) return
    clearTimeout(queueWait.timer)
    queueWait.line.remove()
    queueWait = null
  }

  // Our message waits behind another user: show the place, poll until it is
  // our turn (typing indicator only once it is actually being answered).
  const waitInQueue = ({ ticket, position }: QueuedChat): void => {
    const line = document.createElement('div')
    line.className = 'chat-msg agent chat-queue'
    line.setAttribute('role', 'status')
    messages.appendChild(line)
    const wait = { timer: undefined as ReturnType<typeof setTimeout> | undefined, line }
    queueWait = wait
    const render = (place: number): void => {
      if (place <= 0) {
        line.className = 'chat-thinking'
        line.style.cssText = 'font-style: italic; opacity: 0.7;'
        line.textContent = 'PM agent is thinking…'
      } else {
        line.className = 'chat-msg agent chat-queue'
        line.style.cssText = ''
        line.textContent = queueText(place)
      }
      messages.scrollTop = messages.scrollHeight
    }
    render(position)
    let failures = 0
    const finish = (): void => {
      line.remove()
      if (queueWait === wait) queueWait = null
    }
    const tick = (): void => {
      const poll = options.client.poll
      if (!poll) {
        finish()
        showError('chat queue unavailable')
        return
      }
      poll.call(options.client, ticket).then(
        (res) => {
          if (queueWait !== wait) return
          failures = 0
          if (res.status === 'done') {
            finish()
            appendMessage('agent', res.reply)
            return
          }
          if (res.status === 'expired') {
            finish()
            showError('Your place in the queue expired. Please send your message again.')
            return
          }
          render(res.status === 'queued' ? res.position : 0)
          wait.timer = setTimeout(tick, options.pollIntervalMs ?? QUEUE_POLL_INTERVAL_MS)
        },
        (err: unknown) => {
          if (queueWait !== wait) return
          failures += 1
          if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
            finish()
            showError(err instanceof Error ? err.message : 'chat status failed')
            return
          }
          wait.timer = setTimeout(tick, options.pollIntervalMs ?? QUEUE_POLL_INTERVAL_MS)
        },
      )
    }
    wait.timer = setTimeout(tick, options.pollIntervalMs ?? QUEUE_POLL_INTERVAL_MS)
  }

  const setOpen = (open: boolean): void => {
    panel.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    toggle.setAttribute('aria-label', open ? 'Close chat' : 'Open chat')
    if (open) input.focus()
    // Closing the panel abandons a queued message: stop polling so the server
    // drops the ticket and does not hold others up.
    else stopQueueWait()
  }

  toggle.addEventListener('click', () => setOpen(panel.hidden))
  element.querySelector('.chat-close')!.addEventListener('click', () => setOpen(false))
  element.querySelector<HTMLButtonElement>('.chat-send')!.addEventListener('click', send)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') send()
  })

  return element
}
