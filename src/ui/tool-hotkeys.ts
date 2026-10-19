/**
 * Single source of truth for canvas tool keyboard shortcuts.
 *
 * This module is intentionally dependency-free (no DOM, no engine imports) so
 * both the toolbar tooltips and the window keydown handler can share it, and
 * so it stays unit-testable in a plain node environment.
 *
 * Key assignment notes (fixed by product decision, do not reshuffle casually):
 * - Selection uses both 'a' and 's' (plus legacy alias 'v', kept working for
 *   muscle memory but hidden from tooltips) — the old handler only knew V/W.
 * - 'f' keeps its long-standing "toggle furniture catalog" behaviour.
 * - Ctrl/Meta/Alt/Shift combos are deliberately NOT tool shortcuts: bare keys
 *   only, so existing Ctrl shortcuts (Ctrl+A select-all, Ctrl+C/V/D clipboard,
 *   Ctrl+Z/Y undo-redo) and snap modifiers stay untouched.
 * - 'panning' is deliberately absent: main.ts pans only via middle-click /
 *   space-drag (an engine 'panning' tool has no pointer UI path at all), so a
 *   hotkey for it would switch the status bar into a mode where clicks do
 *   nothing visible — pruned by ticket C2 rather than shipped dead.
 *
 * Wired into main.ts: toolbar tooltips (tooltipFor/shortcutTooltip) and the
 * window keydown dispatch (isToolShortcutEvent).
 */

export type ToolHotkeyId =
  | 'selection'
  | 'wall'
  | 'room'
  | 'polyline'
  | 'dimensionLine'
  | 'label'
  | 'roof'
  | 'furniture'

export interface ToolHotkey {
  id: ToolHotkeyId
  label: string
  /** Lowercase single characters, shown in tooltips, in priority order. */
  keys: string[]
  /** Extra lowercase keys that also work but are not shown in tooltips. */
  aliases?: string[]
}

export const TOOL_HOTKEYS: readonly ToolHotkey[] = Object.freeze([
  { id: 'selection', label: 'Select', keys: ['a', 's'], aliases: ['v'] },
  { id: 'wall', label: 'Wall tool', keys: ['w'] },
  { id: 'room', label: 'Room tool', keys: ['r'] },
  { id: 'polyline', label: 'Polyline tool', keys: ['p'] },
  { id: 'dimensionLine', label: 'Dimension', keys: ['d'] },
  { id: 'label', label: 'Text', keys: ['t'] },
  { id: 'roof', label: 'Roof tool', keys: ['o'] },
  { id: 'furniture', label: 'Furniture catalog', keys: ['f'] },
])

const byKey = new Map<string, ToolHotkey>()
for (const entry of TOOL_HOTKEYS) {
  for (const key of [...entry.keys, ...(entry.aliases ?? [])]) {
    byKey.set(key.toLowerCase(), entry)
  }
}

/** Resolve a bare key (case-insensitive) to its tool, or null if unmapped. */
export function toolForKey(key: string): ToolHotkey | null {
  return byKey.get(key.toLowerCase()) ?? null
}

/**
 * Match a keyboard event as a tool shortcut. Returns null while any modifier
 * is held — modifiers belong to snapping and to the existing Ctrl/Meta
 * shortcuts (undo, select-all, clipboard), never to bare tool keys.
 */
export function isToolShortcutEvent(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}): ToolHotkey | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null
  return toolForKey(e.key)
}

/**
 * Tooltip for a tool: registry label plus its visible keys uppercased,
 * e.g. 'Select (A / S)', 'Wall tool (W)'. The optional description is extra
 * detail appended after the key hint, e.g. 'Wall tool (W) — Draw wall segments'.
 */
export function tooltipFor(id: ToolHotkeyId, description?: string): string {
  const entry = TOOL_HOTKEYS.find((t) => t.id === id)
  if (!entry) return ''
  const keys = entry.keys.map((k) => k.toUpperCase()).join(' / ')
  const hint = `${entry.label} (${keys})`
  return description ? `${hint} — ${description}` : hint
}

/** True on macOS (⌘/⌥/⇧ symbols); safe when navigator is unavailable (SSR/tests). */
export function isMacPlatform(nav?: { platform?: string; userAgent?: string }): boolean {
  const n = nav ?? (typeof globalThis !== 'undefined' ? globalThis.navigator : undefined)
  if (!n) return false
  const platform = (n.platform ?? '').toLowerCase()
  if (platform.startsWith('mac')) return true
  // Fallback for browsers that leave platform blank: sniff the user agent.
  return /macintosh|mac os x/.test((n.userAgent ?? '').toLowerCase())
}

/** Human label for a modifier key: ⌘/⌥/⇧ on mac, Ctrl/Alt/Shift elsewhere. */
export function modifierSymbol(kind: 'ctrl' | 'alt' | 'shift', mac: boolean): string {
  if (kind === 'ctrl') return mac ? '⌘' : 'Ctrl'
  if (kind === 'alt') return mac ? '⌥' : 'Alt'
  return mac ? '⇧' : 'Shift'
}

/**
 * Tooltip for non-tool shortcuts (undo/redo, etc). Modifier names map through
 * modifierSymbol; any other combo item is a key rendered uppercase. mac joins
 * tightly (⌘⇧Z), non-mac joins with '+' (Ctrl+Shift+Z).
 * e.g. shortcutTooltip('Undo', ['ctrl', 'z'], false) -> 'Undo (Ctrl+Z)'.
 */
export function shortcutTooltip(
  label: string,
  combo: Array<'ctrl' | 'alt' | 'shift' | string>,
  mac: boolean,
): string {
  const parts = combo.map((c) =>
    c === 'ctrl' || c === 'alt' || c === 'shift' ? modifierSymbol(c, mac) : c.toUpperCase(),
  )
  return `${label} (${parts.join(mac ? '' : '+')})`
}

/**
 * True when the event target is somewhere the user is typing (text input,
 * dialog, contenteditable) — tool shortcuts must not fire there. Mirrors the
 * guard in main.ts's window keydown handler. Duck-typed so unit tests can
 * pass a minimal fake element (tagName / isContentEditable / closest).
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as {
    tagName?: string
    isContentEditable?: boolean
    closest?: (selectors: string) => unknown
  } | null
  if (!el || typeof el !== 'object') return false
  const tag = (el.tagName ?? '').toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return typeof el.closest === 'function' &&
    !!el.closest('.prefs-overlay, dialog, [role="dialog"]')
}
