import { createServer, type Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { HelloMessage } from '../automation/client'

export interface OrchestratorSentRequest {
  id: string
  type: string
  params?: Record<string, unknown>
}

interface PendingResponse {
  resolve: (value: Record<string, unknown>) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Minimal stand-in for the Track C orchestrator: a WS server on 127.0.0.1
 * that records hello, sends requests, and collects responses by id.
 * Dev/test only — never imported by shipped code paths.
 */
export class MockOrchestrator {
  private server?: Server
  private wss?: WebSocketServer
  private socket?: WebSocket
  private pending = new Map<string, PendingResponse>()
  private idCounter = 0

  hello?: HelloMessage
  readonly requestsSent: OrchestratorSentRequest[] = []
  readonly unexpected: unknown[] = []

  /** Resolves with the bound port. */
  start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer()
      this.wss = new WebSocketServer({ server: this.server })
      this.wss.on('connection', (ws) => {
        this.socket = ws
        ws.on('message', (raw) => this.onMessage(String(raw)))
      })
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server!.address()
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('no bound port'))
      })
    })
  }

  private onMessage(frame: string): void {
    for (const line of frame.split('\n')) {
      if (!line.trim()) continue
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        this.unexpected.push(line)
        continue
      }
      const m = msg as Record<string, unknown>
      if (m.type === 'hello') {
        this.hello = m as unknown as HelloMessage
      } else if (typeof m.id === 'string' && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!
        clearTimeout(p.timer)
        this.pending.delete(m.id)
        p.resolve(m)
      } else {
        this.unexpected.push(msg)
      }
    }
  }

  sendRequest(type: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `req-${++this.idCounter}`
    const req: OrchestratorSentRequest = params === undefined ? { id, type } : { id, type, params }
    this.requestsSent.push(req)
    const p = this.awaitResponseFor(id)
    this.socket?.send(JSON.stringify(req) + '\n')
    return p
  }

  /** Registers a pending response slot for an externally sent raw frame. */
  awaitResponseFor(id: string, timeoutMs = 2000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timeout waiting for response to ${id}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
    })
  }

  /** Sends arbitrary bytes as one newline-terminated frame (test seam). */
  sendRaw(line: string): void {
    this.socket?.send(line + '\n')
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const p of this.pending.values()) clearTimeout(p.timer)
      this.pending.clear()
      this.socket?.close()
      this.wss?.close(() => this.server?.close(() => resolve()))
    })
  }
}
