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
  /** Sends one user message, resolves with the agent's reply text. */
  send(message: OutgoingChatMessage): Promise<string>
}

export interface ChatWidgetOptions {
  client: PmAgentClient
  /** Real logged-in user's id, or null when signed out. */
  getUserId: () => string | null
}

/**
 * Simple fetch client for the pm-agent chat round-trip (POST out, JSON
 * `{ reply }` back). `endpoint` is injected — nothing here hardcodes a URL.
 * Endpoint path for the real backend lands with A2.
 */
export function createFetchPmAgentClient(fetchImpl: typeof fetch, endpoint: string): PmAgentClient {
  return {
    async send({ userId, text }): Promise<string> {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, message: text }),
      })
      if (!response.ok) throw new Error(`chat request failed (${response.status})`)
      const data = (await response.json()) as { reply?: unknown }
      if (typeof data.reply !== 'string') throw new Error('chat reply missing')
      return data.reply
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
    error.hidden = true
    input.value = ''
    appendMessage('user', text)
    void options.client.send({ userId, text }).then(
      (reply) => appendMessage('agent', reply),
      (err: unknown) => showError(err instanceof Error ? err.message : 'chat request failed'),
    )
  }

  const setOpen = (open: boolean): void => {
    panel.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    toggle.setAttribute('aria-label', open ? 'Close chat' : 'Open chat')
    if (open) input.focus()
  }

  toggle.addEventListener('click', () => setOpen(panel.hidden))
  element.querySelector('.chat-close')!.addEventListener('click', () => setOpen(false))
  element.querySelector<HTMLButtonElement>('.chat-send')!.addEventListener('click', send)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') send()
  })

  return element
}
