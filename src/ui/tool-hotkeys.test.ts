import { describe, expect, it } from 'vitest'
import type { PlanTool } from '../plan/engine'
import {
  TOOL_HOTKEYS,
  isMacPlatform,
  isToolShortcutEvent,
  isTypingTarget,
  modifierSymbol,
  shortcutTooltip,
  tooltipFor,
  toolForKey,
  type ToolHotkeyId,
} from './tool-hotkeys'

const modifierEvent = (
  mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> & { key?: string } = {},
) => ({
  key: 'w',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

describe('TOOL_HOTKEYS registry', () => {
  it('has no duplicate keys or aliases across all entries', () => {
    const seen = new Set<string>()
    for (const entry of TOOL_HOTKEYS) {
      for (const key of [...entry.keys, ...(entry.aliases ?? [])]) {
        expect(seen.has(key), `duplicate hotkey '${key}' on ${entry.id}`).toBe(false)
        seen.add(key)
      }
    }
  })

  it('covers every PlanTool id plus furniture with at least one key', () => {
    const planTools: PlanTool[] = ['selection', 'panning', 'wall', 'room', 'polyline', 'dimensionLine', 'label', 'roof']
    const required: ToolHotkeyId[] = [...planTools, 'furniture']
    for (const id of required) {
      const entry = TOOL_HOTKEYS.find((t) => t.id === id)
      expect(entry, `missing registry entry for '${id}'`).toBeDefined()
      expect(entry!.keys.length, `'${id}' has no keys`).toBeGreaterThan(0)
    }
  })

  it('keeps selection on a/s (alias v) and wall on w — user-fixed mapping', () => {
    expect(TOOL_HOTKEYS.find((t) => t.id === 'selection')).toMatchObject({
      keys: ['a', 's'],
      aliases: ['v'],
    })
    expect(TOOL_HOTKEYS.find((t) => t.id === 'wall')).toMatchObject({ keys: ['w'] })
  })
})

describe('tooltipFor', () => {
  it('renders the known tooltip shapes', () => {
    expect(tooltipFor('selection')).toBe('Select (A / S)')
    expect(tooltipFor('wall')).toBe('Wall tool (W)')
    expect(tooltipFor('panning')).toBe('Pan (hand) (H)')
  })

  it('uppercases every key of every entry', () => {
    for (const entry of TOOL_HOTKEYS) {
      const tip = tooltipFor(entry.id)
      for (const key of entry.keys) {
        expect(tip, `tooltip for ${entry.id} missing '${key.toUpperCase()}'`).toContain(key.toUpperCase())
      }
    }
  })

  it('appends an optional description after the key hint', () => {
    expect(tooltipFor('wall', 'Draw wall segments')).toBe('Wall tool (W) — Draw wall segments')
  })
})

describe('toolForKey', () => {
  it('is case-insensitive over keys', () => {
    expect(toolForKey('w')?.id).toBe('wall')
    expect(toolForKey('W')?.id).toBe('wall')
    expect(toolForKey('A')?.id).toBe('selection')
    expect(toolForKey('S')?.id).toBe('selection')
  })

  it('resolves the legacy alias v to selection', () => {
    expect(toolForKey('v')?.id).toBe('selection')
    expect(toolForKey('V')?.id).toBe('selection')
  })

  it('returns null for unmapped keys', () => {
    expect(toolForKey('x')).toBeNull()
    expect(toolForKey('')).toBeNull()
  })
})

describe('isToolShortcutEvent', () => {
  it('matches a bare key press', () => {
    expect(isToolShortcutEvent(modifierEvent({}))?.id).toBe('wall')
    expect(isToolShortcutEvent(modifierEvent({ key: 'V' }))?.id).toBe('selection')
  })

  it('returns null while any modifier is held', () => {
    expect(isToolShortcutEvent(modifierEvent({ ctrlKey: true }))).toBeNull()
    expect(isToolShortcutEvent(modifierEvent({ metaKey: true }))).toBeNull()
    expect(isToolShortcutEvent(modifierEvent({ altKey: true }))).toBeNull()
    expect(isToolShortcutEvent(modifierEvent({ shiftKey: true }))).toBeNull()
  })
})

describe('isMacPlatform', () => {
  it('detects mac and non-mac platforms', () => {
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true)
    expect(isMacPlatform({ platform: 'Win32' })).toBe(false)
    expect(isMacPlatform({ platform: 'Linux x86_64' })).toBe(false)
  })

  it('falls back to the user agent and tolerates empty input', () => {
    expect(isMacPlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe(true)
    expect(isMacPlatform({ platform: '', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe(false)
    expect(isMacPlatform({})).toBe(false)
  })
})

describe('modifierSymbol / shortcutTooltip', () => {
  it('renders mac vs non-mac symbols', () => {
    expect(modifierSymbol('ctrl', false)).toBe('Ctrl')
    expect(modifierSymbol('alt', false)).toBe('Alt')
    expect(modifierSymbol('shift', false)).toBe('Shift')
    expect(modifierSymbol('ctrl', true)).toBe('⌘')
    expect(modifierSymbol('alt', true)).toBe('⌥')
    expect(modifierSymbol('shift', true)).toBe('⇧')
  })

  it('renders undo/redo tooltips in both styles', () => {
    expect(shortcutTooltip('Undo', ['ctrl', 'z'], false)).toBe('Undo (Ctrl+Z)')
    expect(shortcutTooltip('Undo', ['ctrl', 'z'], true)).toBe('Undo (⌘Z)')
    expect(shortcutTooltip('Redo', ['ctrl', 'shift', 'z'], false)).toBe('Redo (Ctrl+Shift+Z)')
    expect(shortcutTooltip('Redo', ['ctrl', 'shift', 'z'], true)).toBe('Redo (⌘⇧Z)')
  })
})

describe('isTypingTarget', () => {
  const fake = (props: Record<string, unknown>) => props as unknown as EventTarget

  it('is true inside text inputs, textareas and selects', () => {
    expect(isTypingTarget(fake({ tagName: 'INPUT' }))).toBe(true)
    expect(isTypingTarget(fake({ tagName: 'TEXTAREA' }))).toBe(true)
    expect(isTypingTarget(fake({ tagName: 'SELECT' }))).toBe(true)
    expect(isTypingTarget(fake({ tagName: 'input' }))).toBe(true)
  })

  it('is true for contenteditable and elements inside dialogs', () => {
    expect(isTypingTarget(fake({ tagName: 'DIV', isContentEditable: true }))).toBe(true)
    expect(isTypingTarget(fake({ tagName: 'DIV', closest: () => ({}) }))).toBe(true)
  })

  it('is false for ordinary canvas-adjacent targets and null', () => {
    expect(isTypingTarget(fake({ tagName: 'DIV', closest: () => null }))).toBe(false)
    expect(isTypingTarget(fake({ tagName: 'CANVAS' }))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
