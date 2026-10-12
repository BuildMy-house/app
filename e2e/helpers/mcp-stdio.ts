import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MCP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mcp')

/** The Python that runs the MCP bridge (HOMELY_MCP_PYTHON, else mcp/.venv); null when it lacks the MCP packages. */
export function mcpPython(): string | null {
  const python = process.env.HOMELY_MCP_PYTHON ?? join(MCP_DIR, '.venv', 'bin', 'python')
  if (!existsSync(python)) return null
  return spawnSync(python, ['-c', 'import mcp, websockets']).status === 0 ? python : null
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

export interface ToolResult {
  isError: boolean
  text: string
  /** Parsed JSON body of a successful call (the tool's dict result). */
  json: unknown
}

/** A real MCP server (mcp/run.sh over stdio, speaking JSON-RPC) with its own app-automation port. */
export class McpStdioServer {
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>()
  private nextId = 1
  private buffer = ''

  private constructor(private readonly child: ChildProcessWithoutNullStreams, readonly automationPort: number) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      for (let newline = this.buffer.indexOf('\n'); newline >= 0; newline = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (!line.trim()) continue
        const message = JSON.parse(line) as { id?: number }
        if (typeof message.id === 'number') this.pending.get(message.id)?.(message as Record<string, unknown>)
      }
    })
  }

  static async start(python: string): Promise<McpStdioServer> {
    const port = await freePort()
    const child = spawn(join(MCP_DIR, 'run.sh'), [], {
      cwd: MCP_DIR,
      env: { ...process.env, HOMELY_MCP_PYTHON: python, HOMELY_MCP_PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const server = new McpStdioServer(child, port)
    await server.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    return server
  }

  private rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 60_000)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(message)
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const response = await this.rpc('tools/call', { name, arguments: args })
    if (response.error) throw new Error(`MCP ${name}: ${JSON.stringify(response.error)}`)
    const result = response.result as { isError?: boolean; content: Array<{ type: string; text?: string }> }
    const text = result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
    let json: unknown = null
    if (!result.isError) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    return { isError: result.isError === true, text, json }
  }

  stop(): void {
    this.child.kill()
  }
}
