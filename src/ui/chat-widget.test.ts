// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createChatWidget,
  createFetchPmAgentClient,
  isPmAgentChatEnabled,
  userIdFromToken,
  type OutgoingChatMessage,
  type PmAgentClient,
} from './chat-widget'

const USER_ID = '2ec4cbfd-95ab-4e04-a690-b7600786b3d9'

function jwtWithSub(sub: string): string {
  return `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ sub }))}.signature`
}

function mount(client: PmAgentClient, getUserId: () => string | null = () => USER_ID): HTMLDivElement {
  const element = createChatWidget({ client, getUserId })
  document.body.appendChild(element)
  return element
}

function open(element: HTMLDivElement): void {
  element.querySelector<HTMLButtonElement>('.chat-toggle')!.click()
}

function sendFrom(element: HTMLDivElement, text: string): void {
  const input = element.querySelector<HTMLInputElement>('.chat-input')!
  input.value = text
  element.querySelector<HTMLButtonElement>('.chat-send')!.click()
}

function panelMessages(element: HTMLDivElement): string[] {
  return Array.from(element.querySelectorAll('.chat-msg'), (node) => node.textContent ?? '')
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllEnvs()
})

describe('chat widget feature flag', () => {
  it('defaults off; only the exact string "true" enables it', () => {
    vi.stubEnv('VITE_ENABLE_PM_AGENT_CHAT', undefined)
    expect(isPmAgentChatEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_PM_AGENT_CHAT', 'false')
    expect(isPmAgentChatEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_PM_AGENT_CHAT', '1')
    expect(isPmAgentChatEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_PM_AGENT_CHAT', 'true')
    expect(isPmAgentChatEnabled()).toBe(true)
  })
})

describe('chat widget open/close', () => {
  it('starts closed, toggle opens and closes it', () => {
    const element = mount({ send: vi.fn() })
    const toggle = element.querySelector<HTMLButtonElement>('.chat-toggle')!
    const panel = element.querySelector<HTMLDivElement>('.chat-panel')!
    expect(panel.hidden).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    toggle.click()
    expect(panel.hidden).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    toggle.click()
    expect(panel.hidden).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('header close button closes the panel', () => {
    const element = mount({ send: vi.fn() })
    open(element)
    expect(element.querySelector<HTMLDivElement>('.chat-panel')!.hidden).toBe(false)
    element.querySelector<HTMLButtonElement>('.chat-close')!.click()
    expect(element.querySelector<HTMLDivElement>('.chat-panel')!.hidden).toBe(true)
  })
})

describe('chat widget send/receive', () => {
  it('sends the typed message with the real user id and renders the reply', async () => {
    const send = vi.fn(async (message: OutgoingChatMessage) => `echo:${message.text}`)
    const element = mount({ send })
    open(element)
    sendFrom(element, 'Hello there')

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ userId: USER_ID, text: 'Hello there' })
    expect(panelMessages(element)).toEqual(['Hello there'])
    await vi.waitFor(() => expect(panelMessages(element)).toEqual(['Hello there', 'echo:Hello there']))
    expect(element.querySelector<HTMLInputElement>('.chat-input')!.value).toBe('')
    expect(element.querySelector<HTMLParagraphElement>('.chat-error')!.hidden).toBe(true)
  })

  it('carries the real user id on every outgoing message', async () => {
    const send = vi.fn(async (message: OutgoingChatMessage) => `ack:${message.userId}`)
    const element = mount({ send })
    open(element)
    sendFrom(element, 'first')
    sendFrom(element, 'second')

    expect(send).toHaveBeenCalledTimes(2)
    for (const call of send.mock.calls) {
      expect(call[0].userId).toBe(USER_ID)
      expect(call[0].userId).not.toBeNull()
    }
    await vi.waitFor(() => expect(panelMessages(element).length).toBe(4))
  })

  it('Enter in the input sends', () => {
    const send = vi.fn(async () => 'ok')
    const element = mount({ send })
    open(element)
    const input = element.querySelector<HTMLInputElement>('.chat-input')!
    input.value = 'enter key'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({ userId: USER_ID, text: 'enter key' })
  })

  it('empty input does not send', () => {
    const send = vi.fn(async () => 'ok')
    const element = mount({ send })
    open(element)
    sendFrom(element, '   ')
    expect(send).not.toHaveBeenCalled()
  })

  it('renders a backend failure as an error instead of dropping it', async () => {
    const send = vi.fn(async () => {
      throw new Error('chat request failed (404)')
    })
    const element = mount({ send })
    open(element)
    sendFrom(element, 'hi')
    const error = element.querySelector<HTMLParagraphElement>('.chat-error')!
    await vi.waitFor(() => expect(error.hidden).toBe(false))
    expect(error.textContent).toContain('chat request failed (404)')
  })
})

describe('chat widget real-user-id requirement', () => {
  it('refuses to send when no logged-in user id is available', () => {
    const send = vi.fn(async () => 'should never happen')
    const element = mount({ send }, () => null)
    open(element)
    sendFrom(element, 'anonymous attempt')

    expect(send).not.toHaveBeenCalled()
    expect(panelMessages(element)).toEqual([])
    const error = element.querySelector<HTMLParagraphElement>('.chat-error')!
    expect(error.hidden).toBe(false)
    expect(error.textContent).toContain('Sign in')
    // the typed text is kept, not silently discarded
    expect(element.querySelector<HTMLInputElement>('.chat-input')!.value).toBe('anonymous attempt')
  })

  it('treats an empty user id as signed out too', () => {
    const send = vi.fn(async () => 'should never happen')
    const element = mount({ send }, () => '')
    open(element)
    sendFrom(element, 'no id')
    expect(send).not.toHaveBeenCalled()
    expect(element.querySelector<HTMLParagraphElement>('.chat-error')!.hidden).toBe(false)
  })
})

describe('userIdFromToken', () => {
  it('reads the real user id from the stored auth JWT sub claim', () => {
    expect(userIdFromToken(jwtWithSub(USER_ID))).toBe(USER_ID)
  })

  it('returns null instead of a placeholder for missing or malformed tokens', () => {
    expect(userIdFromToken(null)).toBeNull()
    expect(userIdFromToken('')).toBeNull()
    expect(userIdFromToken('not-a-jwt')).toBeNull()
    expect(userIdFromToken(jwtWithSub(''))).toBeNull()
    expect(userIdFromToken('a.%%%not-base64%%%.c')).toBeNull()
  })
})

describe('createFetchPmAgentClient', () => {
  it('POSTs { userId, message } to the injected endpoint and reads the reply', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ reply: 'pong' }),
    }) as unknown as Response)
    const client = createFetchPmAgentClient(fetchMock as unknown as typeof fetch, '/api/chat')

    await expect(client.send({ userId: USER_ID, text: 'ping' })).resolves.toBe('pong')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ userId: USER_ID, message: 'ping' }),
      }),
    )
  })

  it('rejects on a non-OK response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }) as unknown as Response)
    const client = createFetchPmAgentClient(fetchMock as unknown as typeof fetch, '/api/chat')
    await expect(client.send({ userId: USER_ID, text: 'ping' })).rejects.toThrow('chat request failed (404)')
  })
})
