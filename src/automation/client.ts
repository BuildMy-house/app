import type { NormalizedHomeState } from '../core/home'

export const PROTOCOL_VERSION = 1

export interface HelloMessage {
  type: 'hello'
  app: 'homely'
  version: number
  mode: string
}

export interface AutomationRequest {
  id: string
  type: string
  params?: Record<string, unknown>
}

export type CommandResult = { ok: true; data: unknown } | { ok: false; error: string; code: string }

/** The set of command types this client answers, implemented by HomelyCommandHandler. */
export interface CommandHandler {
  readonly commands: readonly string[]
  execute(type: string, params: Record<string, unknown>): Promise<CommandResult> | CommandResult
}

export type ClientStatus = 'connecting' | 'open' | 'closed'

export interface AutomationClientOptions {
  /** Orchestrator port (env HOMELY_AUTOMATION_PORT upstream). Ignored when url is set. */
  port?: number
  /** Full ws:// URL override. */
  url?: string
  /** Reported in hello; e.g. "gui" or "headless". */
  mode?: string
  onStatus?: (status: ClientStatus) => void
}

/**
 * Browser WebSocket client that connects OUT to the orchestrator
 * (docs/specs/ws-protocol.md v1): hello first, then exactly one response
 * per request. Messages are newline-delimited JSON.
 */
export class AutomationClient {
  private readonly ws: WebSocket

  constructor(
    private readonly handler: CommandHandler,
    options: AutomationClientOptions,
  ) {
    // SECURITY (M17 audit): the app may only be driven by an orchestrator on
    // this machine. Loopback-only is enforced below on purpose — see
    // README.md "Security". Do not loosen the regex or accept other hosts:
    // the protocol has no auth, so a remote orchestrator would get full
    // unauthenticated control of the home (draw/delete/export).
    const url =
      options.url ?? `ws://127.0.0.1:${options.port ?? automationPortFromEnv() ?? 0}`
    if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(url)) {
      throw new Error(`invalid orchestrator URL: ${url}`)
    }
    this.ws = new WebSocket(url)
    options.onStatus?.('connecting')
    this.ws.addEventListener('open', () => {
      options.onStatus?.('open')
      this.send(hello(options.mode ?? 'gui'))
    })
    this.ws.addEventListener('message', (event) => {
      void this.handleFrame(String(event.data))
    })
    this.ws.addEventListener('close', () => options.onStatus?.('closed'))
    this.ws.addEventListener('error', () => options.onStatus?.('closed'))
  }

  close(): void {
    this.ws.close()
  }

  private send(value: unknown): void {
    this.ws.send(JSON.stringify(value) + '\n')
  }

  private async handleFrame(frame: string): Promise<void> {
    for (const line of frame.split('\n')) {
      if (!line.trim()) continue
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      await this.handleMessage(msg)
    }
  }

  private async handleMessage(msg: unknown): Promise<void> {
    if (typeof msg !== 'object' || msg === null) return
    const m = msg as AutomationRequest
    if (typeof m.id !== 'string') return
    if (typeof m.type !== 'string') {
      this.send({
        id: m.id,
        ok: false,
        error: 'request type must be a string',
        code: 'INVALID_REQUEST',
      })
      return
    }
    let result: CommandResult
    try {
      result = await this.handler.execute(m.type, m.params ?? {})
    } catch (err) {
      result = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'INTERNAL',
      }
    }
    this.send(result.ok ? { id: m.id, ok: true, data: result.data } : { id: m.id, ...result })
  }
}

export function hello(mode: string): HelloMessage {
  return { type: 'hello', app: 'homely', version: PROTOCOL_VERSION, mode }
}

function parsePort(raw: string | null | undefined): number | null {
  if (raw === undefined || raw === null || !/^\d+$/.test(raw)) return null
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/** Parse HOMELY_AUTOMATION_PORT from an env-like record (pure; testable). */
export function automationPortFromEnv(env: Record<string, string | undefined> = {}): number | null {
  const raw =
    env.HOMELY_AUTOMATION_PORT ??
    (typeof process !== 'undefined' ? process.env.HOMELY_AUTOMATION_PORT : undefined)
  return parsePort(raw)
}

/** Seam for GUI launch: orchestrator may pass the port via query string. */
export function automationPortFromSearch(search: string): number | null {
  return parsePort(new URLSearchParams(search).get('automationPort'))
}

export type { NormalizedHomeState }
