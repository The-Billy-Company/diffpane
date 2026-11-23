// Copyright (c) 2026 The Billy Company
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rename, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, vi } from 'vite-plus/test'

type Dock = typeof import('../../../backend/runtime/terminal/dock.ts')
type ProcessOptions = ConstructorParameters<
  typeof import('../../../backend/runtime/terminal/pty.ts').TerminalProcess
>[0]

const { authorize, spawn, write, dispose, emitRenderer, hostRequest, hostEvent } = vi.hoisted(() => ({
  authorize: vi.fn<() => Promise<{ response: number }>>(),
  spawn: vi.fn<(options: ProcessOptions) => void>(),
  write: vi.fn<(data: unknown) => void>(),
  dispose: vi.fn<() => Promise<void>>(async () => {}),
  emitRenderer: vi.fn<(label: string, channel: string, ...args: unknown[]) => void>(),
  hostRequest: vi.fn<(method: string, ...args: unknown[]) => Promise<unknown>>(),
  hostEvent: vi.fn<(event: string, listener: (...args: unknown[]) => unknown) => void>(),
}))

vi.doMock('../../../desktop/host/desktop.ts', () => ({
  hostEvent,
  hostRequest,
  emitRenderer,
  reportHostError: (error: unknown) => {
    throw error
  },
}))
vi.doMock('../../../backend/runtime/terminal/pty.ts', () => ({
  validTerminalSize: (cols: unknown, rows: unknown) => cols === 80 && rows === 24,
  TerminalProcess: class {
    readonly isPowerShell = false
    write = write
    dispose = dispose
    resize() {}
    acknowledge() {}

    constructor(options: ProcessOptions) {
      spawn(options)
    }
  },
}))

const { createTerminalDock, dispatchTerminalInvoke, dispatchTerminalSend }: Dock =
  await import('../../../backend/runtime/terminal/dock.ts')
const unavailable = { ok: false, message: 'The terminal is unavailable in this window.' }

function fixture(cwd: string) {
  const created: string[] = []
  const closed: string[] = []
  let visible = false
  let eligible = false
  let workspaceFocused = true
  let terminalFocused = true
  hostRequest.mockImplementation(async (method, ...[first, second]) => {
    if (method === 'terminal.create' && first === 'workspace-42' && typeof second === 'string') {
      created.push(second)
      queueMicrotask(() => {
        void dispatchTerminalInvoke(second, 'terminal-ready', [])
      })
    }
    if (method === 'terminal.close' && typeof first === 'string') closed.push(first)
    if (method === 'terminal.confirm') return (await authorize()).response === 1
    return method === 'terminal.is-focused' ? terminalFocused : undefined
  })

  const dock = createTerminalDock({
    window: {
      label: 'workspace-42',
      isDestroyed: () => false,
      isFocused: () => workspaceFocused,
    },
    eligible: () => eligible,
    workspace: async () => cwd,
    onVisibility(next) {
      visible = next
    },
  })
  return {
    dock,
    created,
    closed,
    setFocus(window: boolean, terminal: boolean) {
      workspaceFocused = window
      terminalFocused = terminal
    },
    async open() {
      eligible = true
      assert.equal(await dock.toggle(), true)
      assert.ok(visible)
      dock.layout(230, 24, 'light')
      const label = created.at(-1)
      assert.ok(label)
      return {
        label,
        start: (cols: number, rows: number) => dispatchTerminalInvoke(label, 'terminal-start', [cols, rows]),
        input: (value: string) => dispatchTerminalSend(label, 'terminal-input', [value]),
        events: () => emitRenderer.mock.calls.filter(([target]) => target === label).map(event => event.slice(1)),
      }
    },
  }
}

test('only an active terminal with native focus can start its workspace shell', async () => {
  vi.clearAllMocks()
  const workspace = fixture(await realpath(tmpdir()))
  assert.equal(await workspace.dock.toggle(), false)
  assert.equal(workspace.created.length, 0)
  workspace.dock.setNewLineShortcut('Shift+F7')
  const terminal = await workspace.open()
  try {
    assert.deepEqual(
      terminal.events().find(([channel]) => channel === 'terminal-new-line-shortcut'),
      ['terminal-new-line-shortcut', 'Shift+F7'],
    )
    workspace.dock.setNewLineShortcut('Shift+Enter')
    assert.deepEqual(terminal.events().at(-1), ['terminal-new-line-shortcut', 'Shift+Enter'])
    assert.throws(() => dispatchTerminalInvoke('terminal-999', 'terminal-start', [80, 24]), /unavailable/)
    await assert.rejects(async () => dispatchTerminalInvoke(terminal.label, 'open-external', []), /unavailable/)
    workspace.setFocus(true, false)
    assert.deepEqual(await terminal.start(80, 24), unavailable)
    workspace.setFocus(true, true)
    assert.deepEqual(await terminal.start(0, 24), { ok: false, message: 'The terminal is too small to start.' })
    assert.equal(authorize.mock.calls.length, 0)

    authorize.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    assert.deepEqual(await terminal.start(80, 24), { ok: false, message: 'Shell start canceled.' })
    assert.equal(spawn.mock.calls.length, 0)
    assert.deepEqual(await terminal.start(80, 24), { ok: true, isPowerShell: false })
    assert.equal(spawn.mock.calls.length, 1)
    const options = spawn.mock.calls[0]?.[0]
    assert.ok(options)
    assert.deepEqual([options.cwd, options.cols, options.rows], [await realpath(tmpdir()), 80, 24])

    terminal.input('local input')
    dispatchTerminalSend('terminal-999', 'terminal-input', ['stale view'])
    workspace.setFocus(false, false)
    terminal.input('unfocused input')
    assert.equal(await workspace.dock.toggle(), false)
    terminal.input('hidden input')
    assert.deepEqual(write.mock.calls, [['local input']])
    assert.equal(dispose.mock.calls.length, 0)
  } finally {
    await workspace.dock.reset()
  }
  assert.equal(dispose.mock.calls.length, 1)
  assert.deepEqual(workspace.closed, [terminal.label])
})

test('closing the view or replacing the folder during consent invalidates a pending start', async () => {
  vi.clearAllMocks()
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'diffpane-terminal-dock-')))
  const cwd = path.join(scratch, 'project')
  await mkdir(cwd)
  const workspace = fixture(cwd)
  try {
    const entered = Promise.withResolvers<void>()
    const consent = Promise.withResolvers<{ response: number }>()
    authorize.mockImplementationOnce(() => {
      entered.resolve()
      return consent.promise
    })
    const first = await workspace.open()
    const pending = first.start(80, 24)
    await entered.promise
    await workspace.dock.reset()
    const confirmation = hostRequest.mock.calls.find(([method]) => method === 'terminal.confirm')
    assert.ok(confirmation)
    assert.ok(
      hostRequest.mock.calls.some(
        ([method, owner, id]) =>
          method === 'terminal.cancel-confirmation' && owner === confirmation[1] && id === confirmation[2],
      ),
    )
    assert.deepEqual(await pending, unavailable)
    consent.resolve({ response: 1 })

    authorize.mockImplementationOnce(async () => {
      await rename(cwd, path.join(scratch, 'previous'))
      await mkdir(cwd)
      return { response: 1 }
    })
    const second = await workspace.open()
    assert.deepEqual(await second.start(80, 24), {
      ok: false,
      message: 'The workspace folder changed. Reopen it before starting a shell.',
    })
    assert.equal(spawn.mock.calls.length, 0)
  } finally {
    await workspace.dock.reset()
    await rm(scratch, { recursive: true, force: true })
  }
})

test('a confirmed Billy command runs with fixed arguments in the terminal', async () => {
  vi.clearAllMocks()
  const cwd = await realpath(tmpdir())
  const workspace = fixture(cwd)
  const terminal = await workspace.open()
  const command = {
    executable: path.join(cwd, 'igor'),
    args: ['auth', 'github', '--workspace', cwd],
    cwd,
    env: {},
    label: 'GitHub CLI',
    description: 'Sign in for GitHub CLI commands.',
    display: 'igor auth github',
  }
  try {
    authorize.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    assert.deepEqual(await workspace.dock.runCommand(command), { ok: false, message: 'Billy action canceled.' })
    assert.equal(spawn.mock.calls.length, 0)
    assert.deepEqual(await workspace.dock.runCommand(command), { ok: true })
    const options = spawn.mock.calls.at(-1)?.[0]
    assert.equal(options?.cwd, cwd)
    assert.deepEqual(options?.command?.args, command.args)
    assert.deepEqual(terminal.events().at(-1), ['terminal-command-started', 'GitHub CLI'])
    assert.deepEqual(await workspace.dock.runCommand(command), {
      ok: false,
      message: 'Stop the active terminal session before starting a Billy action.',
    })
    assert.equal(spawn.mock.calls.length, 1)
  } finally {
    await workspace.dock.reset()
  }
})
