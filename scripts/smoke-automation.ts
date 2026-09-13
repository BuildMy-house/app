/**
 * DoD smoke: local mock WS orchestrator + real homely automation client
 * complete the v1 handshake including a schema-conformant empty home.
 *
 *   npm run smoke [-- --port 8990]
 */
import { AutomationClient } from '../src/automation/client'
import { HomelyCommandHandler } from '../src/automation/homely-handler'
import { HomeStore } from '../src/core/store'
import { MockOrchestrator } from '../src/dev/mock-orchestrator'

const argIdx = process.argv.indexOf('--port')
const portArg = argIdx !== -1 ? Number(process.argv[argIdx + 1]) : NaN
const requestedPort = Number.isInteger(portArg) && portArg > 0 && portArg < 65536 ? portArg : 0

async function main(): Promise<number> {
  const orch = new MockOrchestrator()
  const bound = await orch.start(requestedPort)
  console.log(`[smoke] mock orchestrator listening on ws://127.0.0.1:${bound}`)

  const store = new HomeStore()
  const client = new AutomationClient(new HomelyCommandHandler(store), {
    url: `ws://127.0.0.1:${bound}`,
    mode: 'smoke',
  })

  let failures = 0
  const check = (name: string, cond: boolean): void => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`)
    if (!cond) failures++
  }

  try {
    // hello must be the first message
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for hello')), 3000)
      const iv = setInterval(() => {
        if (orch.hello) {
          clearInterval(iv)
          clearTimeout(t)
          resolve()
        }
      }, 25)
    })
    check(
      `hello {app:"homely",version:1,mode:"smoke"} -> ${JSON.stringify(orch.hello)}`,
      orch.hello?.type === 'hello' &&
        orch.hello.app === 'homely' &&
        orch.hello.version === 1 &&
        orch.hello.mode === 'smoke',
    )

    const ping = await orch.sendRequest('ping')
    check(`ping -> ${JSON.stringify(ping.data)}`, ping.ok === true && ping.data?.pong === true)

    const cap = await orch.sendRequest('get_capabilities')
    check(
      `get_capabilities -> ${JSON.stringify(cap.data)}`,
      Array.isArray(cap.data?.commands) && cap.data.commands.includes('get_state'),
    )

    const reset = await orch.sendRequest('new_home')
    check('new_home -> {}', reset.ok === true)

    const state = await orch.sendRequest('get_state')
    const home = state.data as Record<string, unknown>
    const requiredKeys = [
      'schemaVersion',
      'levels',
      'walls',
      'rooms',
      'furniture',
      'dimensionLines',
      'labels',
      'selection',
      'cameras',
      'capabilities',
    ]
    const cam = home.cameras as Record<string, unknown> | undefined
    const top = cam?.top as Record<string, number | string> | undefined
    check(
      `get_state -> schemaVersion=${String(home.schemaVersion)} levels=${
        Array.isArray(home.levels) ? home.levels.length : '?'
      } topCamera(yaw=${top?.yawDeg},pitch=${top?.pitchDeg})`,
      state.ok === true &&
        requiredKeys.every((k) => k in home) &&
        home.schemaVersion === 1 &&
        Array.isArray(home.levels) &&
        home.levels.length === 0 &&
        top?.yawDeg === -180 && // yaw pi wraps to -180 on the wire (B8 golden)
        top?.pitchDeg === 45 &&
        top?.lens === 'PINHOLE',
    )

    // Catalog commands surface over the wire when a catalog is loaded.
    const cap2 = await orch.sendRequest('get_capabilities')
    const commands = (cap2.data as { commands?: string[] }).commands ?? []
    const catalogCmds = commands.filter((c) => c === 'list_catalog' || c === 'catalog_add_furniture')
    check(
      `get_capabilities -> catalog commands ${JSON.stringify(catalogCmds)}`,
      commands.includes('list_catalog') && commands.includes('catalog_add_furniture'),
    )

    const bad = await orch.sendRequest('definitely_not_a_command')
    check(
      `unknown command -> code=${String(bad.code)}`,
      bad.ok === false && bad.code === 'UNKNOWN_COMMAND',
    )
  } finally {
    client.close()
    await orch.close()
  }

  console.log(failures === 0 ? '[smoke] ALL PASS' : `[smoke] ${failures} FAILURE(S)`)
  return failures === 0 ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[smoke] crashed:', err)
    process.exit(1)
  },
)
