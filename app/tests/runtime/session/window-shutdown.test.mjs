// Copyright (c) 2026 The Billy Company
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test, vi } from 'vite-plus/test'
import { LocalState } from '../../../backend/persistence/database/local-state.ts'

test('application quit waits for accepted storage work and rejects new writes during teardown', async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'diffpane-window-shutdown-'))
  /** @type {Map<string, (...args: unknown[]) => unknown>} */
  const events = new Map()
  /** @type {Map<string, (...args: unknown[]) => unknown>} */
  const handlers = new Map()
  /** @type {PromiseWithResolvers<string>} */
  const loaded = Promise.withResolvers()
  const exited = Promise.withResolvers()
  /** @type {PromiseWithResolvers<number>} */
  const flushStarted = Promise.withResolvers()
  vi.doMock('../../../desktop/host/transport.ts', () => ({
    hostEvent: /** @param {string} name @param {(...args: unknown[]) => unknown} listener */ (name, listener) => {
      events.set(name, listener)
      return () => events.delete(name)
    },
    handleHost: handlers.set.bind(handlers),
    hostRequest: vi.fn(async (method, label) => {
      if (method === 'window.create' && typeof label === 'string') loaded.resolve(label)
      if (method === 'app.exit') exited.resolve(undefined)
    }),
    notifyHost: vi.fn((event, _label, channel, /** @type {unknown[]} */ args) => {
      if (event === 'renderer-event' && channel === 'flush-saves' && typeof args?.[0] === 'number')
        flushStarted.resolve(args[0])
    }),
  }))
  const migrated = vi.spyOn(LocalState.prototype, 'migrate').mockResolvedValue()
  const closed = vi.spyOn(LocalState.prototype, 'close').mockImplementation(() => {})
  const records = { get: () => undefined, list: () => [], put: () => {}, delete: () => false }
  const reads = vi.spyOn(LocalState.prototype, 'read').mockImplementation(async use => use(records))
  const writeStarted = Promise.withResolvers()
  const writeRelease = Promise.withResolvers()
  const writes = vi.spyOn(LocalState.prototype, 'write').mockImplementation(async use => {
    writeStarted.resolve(undefined)
    await writeRelease.promise
    return use(records)
  })
  try {
    const { initializeDesktop } = await import('../../../desktop/host/desktop.ts')
    initializeDesktop({
      appPath: scratch,
      profilePath: scratch,
      logsPath: scratch,
      version: '0.0.0',
      isPackaged: false,
      mediaOrigin: 'http://127.0.0.1:1',
      targets: [],
    })
    await import('../../../backend/runtime/window/main.mjs')
    const label = await loaded.promise
    const invoke = handlers.get('invoke')
    const send = handlers.get('send')
    assert.ok(invoke && send)
    send(label, 'renderer-ready', [])
    events.get('app.exit-requested')?.()
    const flushId = await flushStarted.promise
    // The renderer can begin saving while the quit flush is in progress.
    const accepted = invoke(label, 'preferences-set', ['ideasVisible', true])
    await writeStarted.promise
    send(label, 'saves-flushed', [true, flushId])
    await nextTurn()
    const duringTeardown = invoke(label, 'preferences-set', ['ideasVisible', false])
    const afterWrite = closed.mock.calls.length
    writeRelease.resolve(undefined)
    assert.deepEqual(await duringTeardown, {
      ok: false,
      error: {
        code: 'WINDOW_UNAVAILABLE',
        operation: 'preferences-set',
        message: 'Diffpane is closing.',
        recoverable: true,
      },
    })
    assert.equal(afterWrite, 0)
    assert.deepEqual(await accepted, { ok: true, value: { key: 'ideasVisible', value: true, revision: 1 } })
    await exited.promise
    assert.equal(closed.mock.calls.length, 1)
  } finally {
    writeRelease.resolve(undefined)
    writes.mockRestore()
    reads.mockRestore()
    closed.mockRestore()
    migrated.mockRestore()
    vi.doUnmock('../../../desktop/host/transport.ts')
    await rm(scratch, { recursive: true, force: true })
  }
})
