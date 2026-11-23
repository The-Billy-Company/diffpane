// Copyright (c) 2026 The Billy Company
import assert from 'node:assert/strict'
import { test } from 'vite-plus/test'
import {
  ariaBinding,
  bindingFromEvent,
  bindingLabel,
  createShortcutSequence,
  defaultBinding,
  nativeAccelerator,
  isShortcutAction,
  normalizeBinding,
  shortcutAllowsChord,
  shortcutChordBindings,
  shortcutConflict,
  shortcuts,
} from '../../shared/preferences/shortcuts.ts'

type SequenceEvent = Parameters<ReturnType<typeof createShortcutSequence>['match']>[0]

function keyEvent(key: string, timeStamp: number, modifiers: Partial<SequenceEvent> = {}): SequenceEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    timeStamp,
    ...modifiers,
  }
}

test('default shortcuts are canonical and work together on all desktop platforms', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const isMac = platform === 'darwin'
    for (const action of Object.keys(shortcuts).filter(isShortcutAction)) {
      const binding = defaultBinding(action, isMac)
      assert.equal(normalizeBinding(binding, isMac, shortcuts[action].scope === 'terminal'), binding, action)
      assert.equal(shortcutConflict(action, binding, {}, platform), null, action)
    }
  }
})

test('shifted braces use the physical bracket key and terminal shortcuts accept Shift alone', () => {
  const collapse = keyEvent('{', 0, { code: 'BracketLeft', metaKey: true, shiftKey: true })
  assert.equal(bindingFromEvent(collapse, true), defaultBinding('collapseFolders', true))

  const enter = keyEvent('Enter', 0, { shiftKey: true })
  assert.equal(bindingFromEvent(enter, true), null)
  assert.equal(bindingFromEvent(enter, true, true), defaultBinding('terminalNewLine', true))
  assert.equal(shortcutConflict('terminalNewLine', 'Shift+F6', {}, 'darwin'), 'Focus terminal controls')
  assert.equal(shortcutConflict('refresh', 'Shift+F6', {}, 'darwin'), null)
})

test('chords normalize and display both strokes, and stay out of native accelerators', () => {
  assert.equal(normalizeBinding('  meta + k\t meta+o ', true), 'Primary+K Primary+O')
  assert.equal(normalizeBinding('Primary+K w', true), 'Primary+K W')
  assert.equal(normalizeBinding('Primary+K W O', true), null)
  assert.equal(normalizeBinding('K W', true), null)
  assert.equal(normalizeBinding('Primary+K Escape', true), null)
  assert.equal(bindingLabel('Primary+K Primary+O', true), '⌘K then ⌘O')
  assert.equal(bindingLabel('Primary+K W', false), 'Ctrl+K then W')
  assert.equal(ariaBinding('Primary+K W', true), '')
  assert.equal(nativeAccelerator('Primary+K W', true), null)
  assert.equal(shortcutAllowsChord('openFolder'), false)
  assert.equal(shortcutAllowsChord('closeAllEditors'), true)
  assert.deepEqual(shortcutChordBindings({ closeAllEditors: 'Primary+J W' }, true), [
    'Primary+J W',
    'Primary+K Primary+O',
  ])
})

test('chords can share a prefix while conflicting with a standalone binding in either direction', () => {
  assert.equal(shortcutConflict('closeAllEditors', 'Primary+K W', {}, 'darwin'), null)
  assert.equal(shortcutConflict('closeAllEditors', 'Primary+O W', {}, 'darwin'), 'Open folder')
  assert.equal(shortcutConflict('refresh', 'Primary+K', {}, 'darwin'), 'Close all editors')
})

test('chord matching waits for the second stroke even when it has its own shortcut', () => {
  const bindings = ['Primary+K W', 'Primary+K Primary+O', 'Primary+O']
  const { match } = createShortcutSequence()
  const prefix = keyEvent('k', 0, { metaKey: true })

  assert.deepEqual(match(prefix, true, bindings), { binding: null, consumed: true })
  assert.deepEqual(match(keyEvent('w', 100), true, bindings), { binding: 'Primary+K W', consumed: true })
  assert.deepEqual(match(prefix, true, bindings), { binding: null, consumed: true })
  assert.deepEqual(match(keyEvent('Meta', 100, { metaKey: true }), true, bindings), { binding: null, consumed: true })
  assert.deepEqual(match(keyEvent('o', 200, { metaKey: true }), true, bindings), {
    binding: 'Primary+K Primary+O',
    consumed: true,
  })
  assert.deepEqual(match(keyEvent('o', 300, { metaKey: true }), true, bindings), {
    binding: 'Primary+O',
    consumed: false,
  })
})

test('expired, unmatched and cancelled chords do not swallow subsequent shortcuts', () => {
  const bindings = ['Primary+K W', 'Primary+K Primary+O']
  const { match, reset } = createShortcutSequence()
  const prefix = keyEvent('k', 0, { metaKey: true })
  const other = keyEvent('o', 100, { metaKey: true })

  match(prefix, true, bindings)
  assert.deepEqual(match(keyEvent('Escape', 20), true, bindings), { binding: null, consumed: true })
  assert.deepEqual(match(other, true, bindings), { binding: 'Primary+O', consumed: false })

  match(prefix, true, bindings)
  assert.deepEqual(match(keyEvent('k', 20, { metaKey: true, repeat: true }), true, bindings), {
    binding: null,
    consumed: true,
  })
  assert.deepEqual(match(keyEvent('q', 30), true, bindings), { binding: null, consumed: true })
  assert.deepEqual(match(other, true, bindings), { binding: 'Primary+O', consumed: false })

  match(prefix, true, bindings)
  assert.deepEqual(match({ ...other, timeStamp: 6_000 }, true, bindings), { binding: 'Primary+O', consumed: false })

  match(prefix, true, bindings)
  reset()
  assert.deepEqual(match(other, true, bindings), { binding: 'Primary+O', consumed: false })
})

test('native accelerator reservation changes only when a chord starts or ends', () => {
  const reserved: boolean[] = []
  const { match, reset } = createShortcutSequence(pending => reserved.push(pending))
  const bindings = ['Primary+K Primary+O']
  const prefix = keyEvent('k', 0, { metaKey: true })

  reset()
  match(prefix, true, bindings)
  match(keyEvent('Meta', 10, { metaKey: true }), true, bindings)
  match(keyEvent('k', 25, { metaKey: true, repeat: true }), true, bindings)
  assert.deepEqual(reserved, [true])
  match(keyEvent('o', 30, { metaKey: true }), true, bindings)
  match(prefix, true, bindings)
  reset()
  assert.deepEqual(reserved, [true, false, true, false])
})
