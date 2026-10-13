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

  it('shows a thinking indicator until the reply (or failure) arrives', async () => {
    let resolve!: (reply: string) => void
    const send = vi.fn(() => new Promise<string>((r) => { resolve = r }))
    const element = mount({ send })
    open(element)
    sendFrom(element, 'hi')
    expect(element.querySelector('.chat-thinking')?.textContent).toContain('thinking')
    resolve('done')
    await vi.waitFor(() => expect(panelMessages(element)).toEqual(['hi', 'done']))
    expect(element.querySelector('.chat-thinking')).toBeNull()
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

  it('sends the session token as a bearer Authorization header when signed in', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ reply: 'pong' }),
    }) as unknown as Response)
    const client = createFetchPmAgentClient(fetchMock as unknown as typeof fetch, '/api/chat', () => 'jwt-abc')
    await client.send({ userId: USER_ID, text: 'ping' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat',
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer jwt-abc' },
      }),
    )
  })

  it('omits Authorization when there is no token', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ reply: 'pong' }),
    }) as unknown as Response)
    const client = createFetchPmAgentClient(fetchMock as unknown as typeof fetch, '/api/chat')
    await client.send({ userId: USER_ID, text: 'ping' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/chat',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } }),
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

describe('chat widget queue', () => {
  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0)
  }
  const tickPoll = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(3000)
  }

  function mountQueued(poll: PmAgentClient['poll'], position = 2) {
    vi.useFakeTimers()
    const client: PmAgentClient = { send: vi.fn().mockResolvedValue({ ticket: 'tkt', position }), poll }
    const element = mount(client)
    open(element)
    sendFrom(element, 'hello')
    return element
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the queue position, updates it, then renders the reply once done', async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce({ status: 'queued', position: 1 })
      .mockResolvedValueOnce({ status: 'processing' })
      .mockResolvedValueOnce({ status: 'done', reply: 'here you go' })
    const element = mountQueued(poll, 2)
    await flush()
    expect(element.querySelector('.chat-queue')!.textContent).toContain("number 2 in the queue")
    expect(element.querySelector('.chat-thinking')).toBeNull()

    await tickPoll()
    expect(element.querySelector('.chat-queue')!.textContent).toContain("You're next")

    await tickPoll()
    expect(element.querySelector('.chat-queue')).toBeNull()
    expect(element.querySelector('.chat-thinking')!.textContent).toContain('thinking')

    await tickPoll()
    expect(element.querySelector('.chat-thinking')).toBeNull()
    expect(panelMessages(element)).toEqual(['hello', 'here you go'])
    expect(poll).toHaveBeenCalledWith('tkt')
    await tickPoll()
    expect(poll).toHaveBeenCalledTimes(3)
  })

  it('reports an expired ticket as an error and stops polling', async () => {
    const poll = vi.fn().mockResolvedValue({ status: 'expired' })
    const element = mountQueued(poll)
    await tickPoll()
    expect(element.querySelector('.chat-error')!.textContent).toContain('expired')
    expect(element.querySelector('.chat-queue')).toBeNull()
    await tickPoll()
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it('stops polling and clears the queue line when the widget is closed', async () => {
    const poll = vi.fn().mockResolvedValue({ status: 'queued', position: 3 })
    const element = mountQueued(poll)
    await tickPoll()
    expect(poll).toHaveBeenCalledTimes(1)
    element.querySelector<HTMLButtonElement>('.chat-close')!.click()
    expect(element.querySelector('.chat-queue')).toBeNull()
    await tickPoll()
    await tickPoll()
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it('gives up with an error after repeated poll failures', async () => {
    const poll = vi.fn().mockRejectedValue(new Error('chat status failed (503)'))
    const element = mountQueued(poll)
    await tickPoll()
    await tickPoll()
    await tickPoll()
    expect(poll).toHaveBeenCalledTimes(3)
    expect(element.querySelector('.chat-error')!.textContent).toContain('503')
    expect(element.querySelector('.chat-queue')).toBeNull()
  })

  it('does not send a second message while one is queued', async () => {
    const poll = vi.fn().mockResolvedValue({ status: 'queued', position: 2 })
    const element = mountQueued(poll)
    await flush()
    sendFrom(element, 'again')
    expect(element.querySelector('.chat-error')!.textContent).toContain('wait')
  })
})

describe('createFetchPmAgentClient queue', () => {
  it('returns a ticket when pm-agent answers queued or processing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'queued', ticket: 't1', position: 3, reply: 'x' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'processing', ticket: 't2' })))
    const client = createFetchPmAgentClient(fetchImpl as unknown as typeof fetch, '/api/chat')
    expect(await client.send({ userId: USER_ID, text: 'a' })).toEqual({ ticket: 't1', position: 3 })
    expect(await client.send({ userId: USER_ID, text: 'a' })).toEqual({ ticket: 't2', position: 0 })
  })

  it('polls /status with the ticket and bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'done', reply: 'hi' })))
    const client = createFetchPmAgentClient(fetchImpl as unknown as typeof fetch, '/api/chat', () => 'tok')
    expect(await client.poll!('a b')).toEqual({ status: 'done', reply: 'hi' })
    expect(fetchImpl).toHaveBeenCalledWith('/api/chat/status?ticket=a%20b', { headers: { Authorization: 'Bearer tok' } })
  })

  it('rejects poll on a non-OK or malformed response', async () => {
    const client = createFetchPmAgentClient(
      vi.fn().mockResolvedValueOnce(new Response('{}', { status: 503 })).mockResolvedValueOnce(new Response('{"status":"?"}')) as unknown as typeof fetch,
      '/api/chat',
    )
    await expect(client.poll!('t')).rejects.toThrow('503')
    await expect(client.poll!('t')).rejects.toThrow('invalid')
  })
})
