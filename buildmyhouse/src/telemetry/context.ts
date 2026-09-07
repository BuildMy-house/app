/**
 * Session and device context stamped on every telemetry event.
 * Created once per page load; immutable after init.
 */

let _sid = ''
let _ver = '0.1.0'
let _device: Record<string, string> = {}

/** Initialize session context. Call once at app start. */
export function initContext(version: string): void {
  _sid = crypto.randomUUID()
  _ver = version
  _device = detectDevice()
}

export function getSessionId(): string {
  return _sid
}

export function getVersion(): string {
  return _ver
}

export function getDevice(): Record<string, string> {
  return _device
}

function detectDevice(): Record<string, string> {
  const ua = navigator.userAgent
  const isTauri = '__TAURI_INTERNALS__' in window
  const os = /Windows/.test(ua) ? 'windows'
    : /Mac OS/.test(ua) ? 'macos'
    : /Linux/.test(ua) ? 'linux'
    : 'unknown'
  const renderer = (() => {
    try {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
      if (!gl) return 'none'
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'
    } catch {
      return 'unknown'
    }
  })()
  return {
    os,
    tauri: String(isTauri),
    renderer,
    lang: navigator.language,
  }
}
