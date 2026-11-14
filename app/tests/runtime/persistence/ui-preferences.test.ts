import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { test, vi } from 'vite-plus/test'
import {
  applyUiPreferencePatch,
  defaultAppearance,
  parseUiPreferencePatch,
  parseUiPreferences,
} from '../../../electron/persistence/preferences/ui-preferences.ts'
import type {
  UiPreferences,
  UiPreferencesBridge,
  UiPreferenceUpdate,
} from '../../../electron/persistence/preferences/ui-preferences.ts'
import type { DiffpaneApi } from '../../../electron/runtime/window/preload.ts'
import { createUiPreferences } from '../../../renderer/panels/appearance/ui-preferences.ts'

test('legacy settings are normalized and each preference patch preserves unrelated fields', () => {
  const legacy = parseUiPreferences({
    appearance: { theme: 'light', fontSize: 999 },
    layout: { files: 100, order: ['files', 'ideas', 'right', 'code'] },
    ideasVisible: true,
    ignored: 'unrecognized',
  })
  assert.equal(legacy.appearance?.fontSize, 28)
  assert.equal(legacy.layout?.files, 156)
  assert.equal(legacy.ideasVisible, true)
  assert.equal(Object.keys(legacy).length, 3)
  const patch = parseUiPreferencePatch('appearance', { font: 'monaspace-neon' })
  assert.deepEqual(applyUiPreferencePatch(patch, legacy.appearance), {
    key: 'appearance',
    value: { ...legacy.appearance, font: 'monaspace-neon' },
  })
  assert.deepEqual(parseUiPreferences({ layout: { order: ['files', 'files', 'right', 'code'] } }), {})
  assert.throws(() => parseUiPreferencePatch('ideasVisible', 'true'), /Invalid Diffpane preference/u)
})

test('the emitted preload accepts the Monaspace Neon preference on save and load', async () => {
  const source = await readFile(new URL('../../../electron/runtime/window/preload.cjs', import.meta.url), 'utf8')
  const appearance = { ...defaultAppearance, font: 'monaspace-neon' as const }
  const update = { key: 'appearance', value: appearance, revision: 1 }
  const invoke = vi
    .fn<() => Promise<unknown>>()
    .mockResolvedValueOnce({ ok: true, value: update })
    .mockResolvedValueOnce({ ok: true, value: { appearance } })
  const send = vi.fn<(channel: string, ...args: unknown[]) => void>()
  const exposeInMainWorld = vi.fn<(name: string, api: DiffpaneApi) => void>()
  runInNewContext(source, {
    require: () => ({ contextBridge: { exposeInMainWorld }, ipcRenderer: { invoke, send } }),
    performance,
    process: { platform: process.platform },
  })
  const bridge = exposeInMainWorld.mock.calls[0]?.[1].preferences
  assert.ok(bridge)
  assert.deepEqual(await bridge.set('appearance', { font: 'monaspace-neon' }), update)
  assert.deepEqual(await bridge.get({}), { appearance })
})

test('hydration and acknowledgements preserve newer edits and retire committed legacy settings', async t => {
  const appearanceKey = 'diffpane.appearance'
  const layoutKey = 'diffpane.workspace-layout.v1'
  const visibilityKey = 'diffpane.ideas.visible'
  const items = new Map([
    [appearanceKey, '{"theme":"light"}'],
    [layoutKey, '{"files":330}'],
    [visibilityKey, 'true'],
  ])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    removeItem: (key: string) => items.delete(key),
  })
  t.onTestFinished(() => {
    vi.unstubAllGlobals()
  })

  const loaded = Promise.withResolvers<Partial<UiPreferences>>()
  const firstWrite = Promise.withResolvers<UiPreferenceUpdate>()
  let imported: Partial<UiPreferences> | undefined
  let broadcast: ((update: UiPreferenceUpdate) => void) | undefined
  const writes: { key: string; value: unknown }[] = []
  const bridge: UiPreferencesBridge = {
    get(legacy) {
      imported = legacy
      return loaded.promise
    },
    set(key, value) {
      writes.push({ key, value })
      if (writes.length === 1) return firstWrite.promise
      const patch = parseUiPreferencePatch(key, value)
      return Promise.resolve({
        ...applyUiPreferencePatch(patch, { theme: 'system', font: 'courier' }),
        revision: 4,
      })
    },
    onChange(listener) {
      broadcast = listener
      return () => {
        broadcast = undefined
      }
    },
  }
  const preferences = createUiPreferences(bridge)
  t.onTestFinished(() => preferences.dispose())
  assert.equal(preferences.get('appearance').theme, 'light')
  assert.equal(imported?.layout?.files, 330)
  assert.equal(items.size, 3)

  preferences.set('appearance', { theme: 'system' })
  await Promise.resolve()
  preferences.set('appearance', { fontSize: 23 })
  preferences.set('appearance', { lineNumbers: false })
  const committed = applyUiPreferencePatch(parseUiPreferencePatch('appearance', { theme: 'system', font: 'courier' }))
  broadcast?.({ ...committed, revision: 3 })
  loaded.resolve(imported ?? {})
  await Promise.resolve()
  assert.equal(preferences.get('appearance').theme, 'system')
  assert.equal(preferences.get('appearance').font, 'courier')
  assert.equal(preferences.get('appearance').fontSize, 23)
  assert.equal(items.size, 0)

  const earlier = applyUiPreferencePatch(parseUiPreferencePatch('appearance', { theme: 'system' }))
  firstWrite.resolve({ ...earlier, revision: 2 })
  await preferences.settled()
  assert.deepEqual(writes, [
    { key: 'appearance', value: { theme: 'system' } },
    { key: 'appearance', value: { fontSize: 23, lineNumbers: false } },
  ])
  assert.equal(preferences.get('appearance').font, 'courier')
  assert.equal(preferences.get('appearance').lineNumbers, false)
})

test('settling preferences reports failed writes and retries the queued patch', async t => {
  vi.stubGlobal('localStorage', { getItem: () => null })
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  t.onTestFinished(() => {
    vi.unstubAllGlobals()
    logged.mockRestore()
  })
  let writable = false
  const set: UiPreferencesBridge['set'] = async (key, value) => {
    if (!writable) throw new Error('Storage temporarily unavailable')
    return applyUiPreferencePatch(parseUiPreferencePatch(key, value))
  }
  const preferences = createUiPreferences({
    get: () => Promise.resolve({}),
    set,
    onChange: () => () => {},
  })
  t.onTestFinished(() => preferences.dispose())

  preferences.set('ideasVisible', true)
  await assert.rejects(preferences.settled(), /Storage temporarily unavailable/u)
  assert.equal(preferences.hasSaveError('ideasVisible'), true)
  assert.equal(preferences.get('ideasVisible'), true)

  writable = true
  await preferences.settled()
  assert.equal(preferences.hasSaveError('ideasVisible'), false)
  assert.equal(preferences.get('ideasVisible'), true)
})
