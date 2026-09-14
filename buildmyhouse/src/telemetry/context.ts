/**
 * Session and device context stamped on every telemetry event.
 * Created once per page load; immutable after init.
 */

let _sid = ''
let _ver = '0.1.0'

/** Initialize session context. Call once at app start. */
export function initContext(version: string): void {
  _sid = crypto.randomUUID()
  _ver = version
}

export function getSessionId(): string {
  return _sid
}

export function getVersion(): string {
  return _ver
}
