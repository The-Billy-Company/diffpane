// Copyright (c) 2026 The Billy Company
interface ShortcutDefinition {
  label: string
  group: string
  defaultBinding: ShortcutBinding
  nonMacBinding?: ShortcutBinding
  scope: 'native' | 'window' | 'explorer' | 'reviewNotes' | 'ideas' | 'terminal'
}

export const shortcuts = {
  newWindow: {
    label: 'New window',
    group: 'Window',
    defaultBinding: 'Primary+N',
    scope: 'native',
  },
  openFolder: {
    label: 'Open folder',
    group: 'Window',
    defaultBinding: 'Primary+O',
    scope: 'native',
  },
  openFile: {
    label: 'Open file',
    group: 'Window',
    defaultBinding: 'Primary+Shift+O',
    scope: 'native',
  },
  closeWindow: {
    label: 'Close window',
    group: 'Window',
    defaultBinding: 'Primary+W',
    scope: 'native',
  },
  openSettings: {
    label: 'Open settings',
    group: 'Window',
    defaultBinding: 'Primary+,',
    scope: 'native',
  },
  toggleClaude: {
    label: 'Toggle the Creature panel',
    group: 'Window',
    defaultBinding: 'Primary+Shift+L',
    scope: 'window',
  },
  openClaudeAgent: {
    label: 'Open the Creature in Edit mode',
    group: 'Window',
    defaultBinding: 'Primary+I',
    scope: 'window',
  },
  toggleAssistantSidebar: {
    label: 'Toggle the Creature sidebar',
    group: 'Window',
    defaultBinding: 'Primary+Alt+S',
    scope: 'window',
  },
  toggleZenMode: {
    label: 'Toggle Zen mode',
    group: 'Window',
    defaultBinding: 'Primary+Control+Z',
    nonMacBinding: 'Primary+Alt+Z',
    scope: 'window',
  },
  toggleIdeas: {
    label: 'Toggle Ideas notebook',
    group: 'Window',
    defaultBinding: 'Primary+Shift+I',
    scope: 'window',
  },
  searchFiles: {
    label: 'Search files',
    group: 'Search and navigation',
    defaultBinding: 'Primary+P',
    scope: 'window',
  },
  quickOpen: {
    label: 'Search files (alternate)',
    group: 'Search and navigation',
    defaultBinding: 'Primary+Alt+P',
    scope: 'window',
  },
  searchProject: {
    label: 'Search in project',
    group: 'Search and navigation',
    defaultBinding: 'Primary+Shift+F',
    scope: 'window',
  },
  find: {
    label: 'Find in file or explorer',
    group: 'Search and navigation',
    defaultBinding: 'Primary+F',
    scope: 'window',
  },
  toggleExplorer: {
    label: 'Toggle explorer',
    group: 'Search and navigation',
    defaultBinding: 'Primary+B',
    scope: 'window',
  },
  focusExplorer: {
    label: 'Focus File Explorer',
    group: 'Search and navigation',
    defaultBinding: 'Primary+0',
    nonMacBinding: 'Primary+Alt+0',
    scope: 'window',
  },
  revealActiveFile: {
    label: 'Reveal active file in File Explorer',
    group: 'Search and navigation',
    defaultBinding: 'Primary+Shift+R',
    scope: 'window',
  },
  navigateBack: {
    label: 'Go back',
    group: 'Search and navigation',
    defaultBinding: 'Control+-',
    nonMacBinding: 'Alt+ArrowLeft',
    scope: 'window',
  },
  navigateForward: {
    label: 'Go forward',
    group: 'Search and navigation',
    defaultBinding: 'Control+Shift+-',
    nonMacBinding: 'Alt+ArrowRight',
    scope: 'window',
  },
  previousEditor: {
    label: 'Switch to the previous file',
    group: 'Editing',
    defaultBinding: 'Control+Tab',
    nonMacBinding: 'Primary+Tab',
    scope: 'window',
  },
  closeAllEditors: {
    label: 'Close all editors',
    group: 'Editing',
    defaultBinding: 'Primary+K W',
    scope: 'window',
  },
  closeOtherEditors: {
    label: 'Close other editors',
    group: 'Editing',
    defaultBinding: 'Primary+K Primary+O',
    scope: 'window',
  },
  closeEditorGroup: {
    label: 'Close the code editor',
    group: 'Editing',
    defaultBinding: 'Primary+Shift+]',
    scope: 'window',
  },
  refresh: {
    label: 'Refresh workspace',
    group: 'Search and navigation',
    defaultBinding: 'Primary+R',
    scope: 'window',
  },
  save: {
    label: 'Save file or idea',
    group: 'Editing',
    defaultBinding: 'Primary+S',
    scope: 'window',
  },
  reviewChanges: {
    label: 'Review changes',
    group: 'Review',
    defaultBinding: 'Primary+Shift+G',
    scope: 'window',
  },
  reviewNotes: {
    label: 'Review notes',
    group: 'Review',
    defaultBinding: 'Primary+Shift+J',
    scope: 'window',
  },
  saveReviewNote: {
    label: 'Save review note',
    group: 'Review',
    defaultBinding: 'Primary+Enter',
    scope: 'reviewNotes',
  },
  collapseFolders: {
    label: 'Collapse all folders',
    group: 'Explorer',
    defaultBinding: 'Primary+Shift+[',
    scope: 'window',
  },
  renameExplorerItem: {
    label: 'Rename explorer item',
    group: 'Explorer',
    defaultBinding: 'F2',
    scope: 'explorer',
  },
  explorerContextMenu: {
    label: 'Open explorer item menu',
    group: 'Explorer',
    defaultBinding: 'Shift+F10',
    scope: 'explorer',
  },
  explorerContextMenuKey: {
    label: 'Open explorer item menu (alternate)',
    group: 'Explorer',
    defaultBinding: 'ContextMenu',
    scope: 'explorer',
  },
  formatIdeaBold: {
    label: 'Bold in idea editor',
    group: 'Ideas',
    defaultBinding: 'Primary+B',
    scope: 'ideas',
  },
  formatIdeaItalic: {
    label: 'Italic in idea editor',
    group: 'Ideas',
    defaultBinding: 'Primary+I',
    scope: 'ideas',
  },
  terminalNewLine: {
    label: 'Insert a line break',
    group: 'Terminal',
    defaultBinding: 'Shift+Enter',
    scope: 'terminal',
  },
} as const satisfies Record<string, ShortcutDefinition>

export type ShortcutAction = keyof typeof shortcuts
export type ShortcutBinding = string
export type ShortcutOverrides = Partial<Record<ShortcutAction, ShortcutBinding>>

const ACTIONS = Object.keys(shortcuts).filter(isShortcutAction)

export function isShortcutAction(value: unknown): value is ShortcutAction {
  return typeof value === 'string' && Object.hasOwn(shortcuts, value)
}

export function shortcutAllowsChord(action: ShortcutAction): boolean {
  return shortcuts[action].scope === 'window'
}

export function defaultBinding(action: ShortcutAction, isMac = true): ShortcutBinding {
  const definition: ShortcutDefinition = shortcuts[action]
  return (isMac ? undefined : definition.nonMacBinding) ?? definition.defaultBinding
}

export function effectiveBinding(
  action: ShortcutAction,
  overrides: ShortcutOverrides,
  isMac?: boolean,
): ShortcutBinding {
  return overrides[action] ?? defaultBinding(action, isMac)
}

export function shortcutChordBindings(overrides: ShortcutOverrides, isMac: boolean): ShortcutBinding[] {
  return ACTIONS.filter(shortcutAllowsChord)
    .map(action => effectiveBinding(action, overrides, isMac))
    .filter(binding => binding.includes(' '))
}

interface BuiltInShortcut {
  label: string
  group: string
  binding: ShortcutBinding
  scope?: 'terminal'
}

export function actualSizeBinding(isMac: boolean): ShortcutBinding {
  return isMac ? 'Primary+Alt+0' : 'Primary+0'
}

// These shortcuts follow native menu roles and the standard editing commands.
export function builtInShortcuts(platform: string): BuiltInShortcut[] {
  const isMac = platform === 'darwin'
  return [
    { label: 'Minimize window', group: 'Window', binding: 'Primary+M' },
    ...(isMac
      ? [
          { label: 'Hide Diffpane', group: 'Window', binding: 'Primary+H' },
          { label: 'Hide other apps', group: 'Window', binding: 'Primary+Alt+H' },
        ]
      : []),
    ...(platform === 'win32' ? [] : [{ label: 'Quit Diffpane', group: 'Window', binding: 'Primary+Q' }]),
    { label: 'Undo', group: 'Editing', binding: 'Primary+Z' },
    {
      label: 'Redo',
      group: 'Editing',
      binding: platform === 'win32' ? 'Primary+Y' : 'Primary+Shift+Z',
    },
    { label: 'Cut', group: 'Editing', binding: 'Primary+X' },
    { label: 'Copy', group: 'Editing', binding: 'Primary+C' },
    { label: 'Paste', group: 'Editing', binding: 'Primary+V' },
    { label: 'Select all', group: 'Editing', binding: 'Primary+A' },
    { label: 'Zoom in', group: 'View', binding: 'Primary+Plus' },
    { label: 'Zoom out', group: 'View', binding: 'Primary+-' },
    { label: 'Actual size', group: 'View', binding: actualSizeBinding(isMac) },
    { label: 'Toggle full screen', group: 'View', binding: isMac ? 'Primary+Control+F' : 'F11' },
    { label: 'Focus terminal controls', group: 'Terminal', binding: 'Shift+F6', scope: 'terminal' },
    { label: 'Copy in terminal', group: 'Terminal', binding: 'Primary+Shift+C', scope: 'terminal' },
    { label: 'Paste in terminal', group: 'Terminal', binding: 'Primary+Shift+V', scope: 'terminal' },
  ]
}

function bindingsOverlap(first: ShortcutBinding, second: ShortcutBinding) {
  return first === second || first.startsWith(`${second} `) || second.startsWith(`${first} `)
}

export function shortcutConflict(
  action: ShortcutAction,
  binding: ShortcutBinding,
  overrides: ShortcutOverrides,
  platform: string,
): string | null {
  const isMac = platform === 'darwin'
  const scope: ShortcutDefinition['scope'] = shortcuts[action].scope
  const normalized = normalizeBinding(binding, isMac, scope === 'terminal')
  if (!normalized) return null
  // When both commands use their shared default, the idea editor takes precedence.
  const sharedDefault = normalized === defaultBinding(action, isMac) ? sharedIdeaDefaults[action] : undefined
  const conflict = ACTIONS.find(other => {
    if (other === action || other === sharedDefault) return false
    const otherScope: ShortcutDefinition['scope'] = shortcuts[other].scope
    if (scope !== otherScope && (scope === 'terminal' || otherScope === 'terminal')) {
      if (scope !== 'native' && otherScope !== 'native') return false
    }
    const candidate = normalizeBinding(effectiveBinding(other, overrides, isMac), isMac, otherScope === 'terminal')
    return candidate !== null && bindingsOverlap(normalized, candidate)
  })
  if (conflict) return shortcuts[conflict].label
  const builtIn = builtInShortcuts(platform).find(
    other => (!other.scope || other.scope === scope) && bindingsOverlap(normalized, other.binding),
  )
  return builtIn?.label ?? null
}

const sharedIdeaDefaults: Partial<Record<ShortcutAction, ShortcutAction>> = {
  formatIdeaBold: 'toggleExplorer',
  toggleExplorer: 'formatIdeaBold',
  formatIdeaItalic: 'openClaudeAgent',
  openClaudeAgent: 'formatIdeaItalic',
}

const modifiers = ['Primary', 'Control', 'Meta', 'Alt', 'Shift'] as const
type Modifier = (typeof modifiers)[number]

const modifierNames = new Map(modifiers.map(modifier => [modifier.toLowerCase(), modifier]))
const namedKeys = [
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'Backspace',
  'ContextMenu',
  'Delete',
  'End',
  'Enter',
  'Escape',
  'Home',
  'Insert',
  'PageDown',
  'PageUp',
  'Plus',
  'Space',
  'Tab',
]
const keyNames = new Map(namedKeys.map(key => [key.toLowerCase(), key]))
const functionKey = /^F(?:[1-9]|1\d|2[0-4])$/
const punctuationByCode = new Map([
  ['Backquote', '`'],
  ['Backslash', '\\'],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Comma', ','],
  ['Equal', '='],
  ['Minus', '-'],
  ['Period', '.'],
  ['Quote', "'"],
  ['Semicolon', ';'],
  ['Slash', '/'],
])
const punctuation = new Set(punctuationByCode.values())

function normalizeStroke(stroke: string, isMac: boolean, allowUnmodified: boolean): ShortcutBinding | null {
  const tokens = stroke.split('+')
  const rawKey = tokens.pop()?.trim() ?? ''
  const upper = rawKey.toUpperCase()
  const key =
    /^[A-Z0-9]$/.test(upper) || functionKey.test(upper)
      ? upper
      : (keyNames.get(rawKey.toLowerCase()) ?? (punctuation.has(rawKey) ? rawKey : undefined))
  if (!key) return null

  const pressed = new Set<Modifier>()
  for (const token of tokens) {
    let modifier = modifierNames.get(token.trim().toLowerCase())
    if (modifier === (isMac ? 'Meta' : 'Control')) modifier = 'Primary'
    if (!modifier || pressed.has(modifier)) return null
    pressed.add(modifier)
  }
  // Avoid taking over ordinary typing and keyboard navigation.
  if (
    !allowUnmodified &&
    !functionKey.test(key) &&
    key !== 'ContextMenu' &&
    ![...pressed].some(modifier => modifier !== 'Shift')
  )
    return null

  // The Plus accelerator includes Shift on the Equals key.
  const plus = key === 'Plus' || (key === '=' && pressed.has('Shift'))
  if (plus) pressed.delete('Shift')
  return [...modifiers.filter(modifier => pressed.has(modifier)), plus ? 'Plus' : key].join('+')
}

export function normalizeBinding(value: unknown, isMac: boolean, allowUnmodified = false): ShortcutBinding | null {
  if (typeof value !== 'string' || value.length > 80) return null
  const [first, second, extra] = value
    .trim()
    .replace(/\s*\+\s*/gu, '+')
    .split(/\s+/u)
  if (!first || extra) return null
  const firstStroke = normalizeStroke(first, isMac, allowUnmodified)
  if (!firstStroke || second === undefined) return firstStroke
  const secondStroke = normalizeStroke(second, isMac, true)
  return secondStroke && secondStroke !== 'Escape' ? `${firstStroke} ${secondStroke}` : null
}

type ShortcutKeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> &
  Partial<Pick<KeyboardEvent, 'code' | 'isComposing' | 'getModifierState'>>

export function bindingFromEvent(
  event: ShortcutKeyEvent,
  isMac: boolean,
  allowUnmodified = false,
): ShortcutBinding | null {
  if (event.isComposing || event.getModifierState?.('AltGraph')) return null
  let key = event.key
  if (key === ' ') key = 'Space'
  else if (key === '+') key = 'Plus'
  else if (event.code && !/^[a-z]$/i.test(key)) {
    // Use the base key when Shift or Option changes the produced character.
    if (event.shiftKey || event.altKey) {
      if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3)
      else if (/^Digit\d$/.test(event.code)) key = event.code.slice(5)
      else key = punctuationByCode.get(event.code) ?? key
    }
  }
  const tokens = []
  if (event.metaKey) tokens.push('Meta')
  if (event.ctrlKey) tokens.push('Control')
  if (event.altKey) tokens.push('Alt')
  if (event.shiftKey) tokens.push('Shift')
  return normalizeStroke([...tokens, key].join('+'), isMac, allowUnmodified)
}

export function matchesBinding(event: ShortcutKeyEvent, binding: ShortcutBinding, isMac: boolean) {
  return bindingFromEvent(event, isMac) === binding
}

const chordTimeoutMs = 5000
const modifierKeys = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift'])
type ShortcutStrokeEvent = ShortcutKeyEvent & Pick<KeyboardEvent, 'repeat' | 'timeStamp'>

// A prefix reserves the next keystroke only while a chord is pending.
export function createShortcutSequence(onPendingChange?: (pending: boolean) => void) {
  let pending: { prefix: ShortcutBinding; expires: number } | null = null

  function reset() {
    if (!pending) return
    pending = null
    onPendingChange?.(false)
  }

  function match(event: ShortcutStrokeEvent, isMac: boolean, bindings: readonly ShortcutBinding[]) {
    if (event.isComposing || event.getModifierState?.('AltGraph') || (pending && event.timeStamp >= pending.expires))
      reset()
    if (pending) {
      if (modifierKeys.has(event.key) || event.repeat) return { binding: null, consumed: true }
      const stroke = bindingFromEvent(event, isMac, true)
      const chord = stroke && stroke !== 'Escape' ? `${pending.prefix} ${stroke}` : null
      reset()
      return { binding: chord && bindings.includes(chord) ? chord : null, consumed: true }
    }

    const binding = bindingFromEvent(event, isMac)
    if (binding && bindings.some(candidate => candidate.startsWith(`${binding} `))) {
      if (!event.repeat) {
        pending = { prefix: binding, expires: event.timeStamp + chordTimeoutMs }
        onPendingChange?.(true)
      }
      return { binding: null, consumed: true }
    }
    return { binding, consumed: false }
  }

  return { match, reset }
}

const keyLabels = new Map([
  ['ArrowDown', '↓'],
  ['ArrowLeft', '←'],
  ['ArrowRight', '→'],
  ['ArrowUp', '↑'],
  ['ContextMenu', 'Menu'],
  ['Escape', 'Esc'],
  ['PageDown', 'Page Down'],
  ['PageUp', 'Page Up'],
  ['Plus', '+'],
])

export function bindingKeys(binding: ShortcutBinding, isMac: boolean): string[] {
  const labels = new Map([
    ['Primary', isMac ? '⌘' : 'Ctrl'],
    ['Control', isMac ? '⌃' : 'Ctrl'],
    ['Meta', isMac ? '⌘' : 'Super'],
    ['Alt', isMac ? '⌥' : 'Alt'],
    ['Shift', isMac ? '⇧' : 'Shift'],
  ])
  return binding.split('+').map(key => labels.get(key) ?? keyLabels.get(key) ?? key)
}

export function bindingLabel(binding: ShortcutBinding, isMac: boolean): string {
  return binding
    .split(' ')
    .map(stroke => bindingKeys(stroke, isMac).join(isMac ? '' : '+'))
    .join(' then ')
}

export function ariaBinding(binding: ShortcutBinding, isMac: boolean): string {
  if (binding.includes(' ')) return ''
  return binding
    .split('+')
    .map(key => (key === 'Primary' ? (isMac ? 'Meta' : 'Control') : key))
    .join('+')
}

const nativeKeys = new Map([
  ['ArrowDown', 'Down'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'],
  ['ArrowUp', 'Up'],
  ['Primary', 'CmdOrCtrl'],
])

export function nativeAccelerator(binding: ShortcutBinding, isMac: boolean): string | null {
  const normalized = normalizeBinding(binding, isMac)
  if (!normalized || normalized.includes(' ') || normalized.endsWith('ContextMenu')) return null
  return normalized
    .split('+')
    .map(key => nativeKeys.get(key) ?? key)
    .join('+')
}
