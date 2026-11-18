import { realpath, stat } from 'node:fs/promises'
import type { WorkspaceWindow } from '../../../desktop/host/desktop.ts'
import { emitRenderer, hostEvent, hostRequest, reportHostError } from '../../../desktop/host/desktop.ts'
import { colorHex } from '../../../shared/appearance/palette.ts'
import type { BillySetupStartResult } from '../../../shared/billy/setup.ts'
import type { ShortcutBinding } from '../../../shared/preferences/shortcuts.ts'
import { defaultBinding } from '../../../shared/preferences/shortcuts.ts'
import type { TerminalStartResult } from '../../../shared/terminal/protocol.ts'
import { terminalInitialColumns, terminalInitialRows } from '../../../shared/terminal/protocol.ts'
import { confirmTerminal } from './approval.ts'
import type { TerminalExecutable } from './pty.ts'
import { TerminalProcess, validTerminalSize } from './pty.ts'

interface TerminalHandlers {
  invoke(channel: string, args: unknown[]): unknown
  send(channel: string, args: unknown[]): void
  closed(): Promise<void>
}

let nextTerminal = 0
const terminalViews = new Map<string, TerminalHandlers>()
hostEvent('terminal.closed', label => (typeof label === 'string' ? terminalViews.get(label)?.closed() : undefined))

export function dispatchTerminalInvoke(label: string, channel: string, args: unknown[]) {
  const handlers = terminalViews.get(label)
  if (!handlers) throw new Error('The terminal is unavailable.')
  return handlers.invoke(channel, args)
}

// Native routing admits only the terminal document and verifies focus for user input before dispatch.
export function dispatchTerminalSend(label: string, channel: string, args: unknown[]) {
  terminalViews.get(label)?.send(channel, args)
}

interface DockOptions {
  window: Pick<WorkspaceWindow, 'label' | 'isDestroyed' | 'isFocused'>
  eligible: () => boolean
  workspace: () => Promise<string>
  onVisibility: (visible: boolean) => void
}

interface Surface {
  label: string
  shown: boolean
  loaded: boolean
  focusOnShow: boolean
  creating: Promise<unknown>
  ready: PromiseWithResolvers<boolean>
  layoutWork: Promise<void>
  layoutRevision: number
  prompt?: AbortController
  process?: TerminalProcess
  stopping?: Promise<void>
}

export interface TerminalCommand extends TerminalExecutable {
  cwd: string
  label: string
  description: string
  display: string
}

function denied(message = 'The terminal is unavailable in this window.'): { ok: false; message: string } {
  return { ok: false, message }
}

async function workspaceDirectory(cwd: string) {
  const canonical = await realpath(cwd)
  const directory = await stat(canonical, { bigint: true })
  if (canonical !== cwd || !directory.isDirectory()) throw new Error('The workspace directory changed.')
  return directory
}

function displayPath(cwd: string) {
  return Array.from(cwd, character =>
    /[\p{Cc}\p{Bidi_Control}]/u.test(character) ? `\\u{${character.charCodeAt(0).toString(16)}}` : character,
  ).join('')
}

export function createTerminalDock({ window, eligible, workspace, onVisibility }: DockOptions) {
  let surface: Surface | undefined
  let draining: Promise<void> | undefined
  let commandPrompt: AbortController | undefined
  let layout: { height: number; bottom: number } | undefined
  let theme: 'dark' | 'light' = 'dark'
  let newLineShortcut = defaultBinding('terminalNewLine', process.platform === 'darwin')

  const canShow = () => eligible() && !window.isDestroyed()
  const active = (current: Surface) =>
    surface === current && current.shown && current.loaded && Boolean(layout) && canShow()
  async function keyboardTarget(current: Surface) {
    if (!active(current) || !window.isFocused()) return false
    const focused = await hostRequest('terminal.is-focused', current.label).catch(() => false)
    return focused === true && active(current) && window.isFocused()
  }

  function syncLayout() {
    const current = surface
    if (!current?.loaded || window.isDestroyed()) return
    const revision = ++current.layoutRevision
    current.layoutWork = current.layoutWork.then(() => applyLayout(current, revision)).catch(reportHostError)
  }

  async function applyLayout(current: Surface, revision: number) {
    if (surface !== current || revision !== current.layoutRevision) return
    const mounted = current.shown ? layout : undefined
    const focus = Boolean(mounted && current.focusOnShow && window.isFocused())
    if (focus) current.focusOnShow = false
    await hostRequest(
      'terminal.layout',
      current.label,
      mounted?.height ?? null,
      mounted?.bottom ?? null,
      colorHex(theme, 'canvas'),
      focus,
    )
  }

  function visibility(current: Surface, shown: boolean) {
    current.shown = shown
    current.focusOnShow = shown
    if (!shown) {
      layout = undefined
      current.prompt?.abort()
    }
    syncLayout()
    onVisibility(shown)
  }

  function stop(current: Surface) {
    if (!current.process) return current.stopping ?? Promise.resolve()
    const process = current.process
    current.process = undefined
    const pending = process.dispose().finally(() => {
      if (current.stopping === pending) current.stopping = undefined
    })
    current.stopping = pending
    return pending
  }

  function reset() {
    commandPrompt?.abort()
    commandPrompt = undefined
    const current = surface
    if (!current) return draining ?? Promise.resolve()
    surface = undefined
    terminalViews.delete(current.label)
    current.ready.resolve(false)
    current.prompt?.abort()
    layout = undefined
    const previous = draining
    const pending = Promise.allSettled([previous, stop(current), closeWhenReady(current)]).then(() => {
      if (draining === pending) draining = undefined
      return undefined
    })
    draining = pending
    onVisibility(false)
    return pending
  }

  async function closeWhenReady(current: Surface) {
    await current.creating.catch(() => undefined)
    await current.layoutWork
    await hostRequest('terminal.close', current.label)
  }

  function startProcess(current: Surface, cwd: string, cols: number, rows: number, command?: TerminalExecutable) {
    const process = new TerminalProcess({
      cwd,
      cols,
      rows,
      ...(command ? { command } : {}),
      onData: (data, bytes) => {
        if (surface === current) emitRenderer(current.label, 'terminal-data', data, bytes)
      },
      onExit: (code, reason) => {
        if (code === null) stop(current).catch(() => console.warn('Diffpane could not stop the terminal process.'))
        else current.process = undefined
        if (surface === current) emitRenderer(current.label, 'terminal-exit', code, reason)
      },
    })
    current.process = process
    return process
  }

  async function start(current: Surface, cols: unknown, rows: unknown): Promise<TerminalStartResult> {
    if (
      !(await keyboardTarget(current)) ||
      current.process ||
      current.prompt ||
      current.stopping ||
      draining ||
      commandPrompt
    )
      return denied()
    if (typeof cols !== 'number' || typeof rows !== 'number' || !validTerminalSize(cols, rows))
      return denied('The terminal is too small to start.')
    const prompt = new AbortController()
    current.prompt = prompt
    try {
      const cwd = await workspace()
      const original = await workspaceDirectory(cwd)
      if (prompt.signal.aborted || !(await keyboardTarget(current))) return denied()
      const confirmed = await confirmTerminal(
        window.label,
        {
          title: 'Diffpane Terminal',
          message: 'Start a shell in this folder?',
          detail: `The shell runs with your user account’s permissions and loads your shell configuration.\n\n${displayPath(cwd)}`,
          approve: 'Start Shell',
        },
        prompt.signal,
      )
      if (prompt.signal.aborted || !active(current)) return denied()
      if (!confirmed) return denied('Shell start canceled.')
      const approved = await workspaceDirectory(cwd)
      if (prompt.signal.aborted || !active(current)) return denied()
      if (approved.dev !== original.dev || approved.ino !== original.ino)
        return denied('The workspace folder changed. Reopen it before starting a shell.')
      return { ok: true, isPowerShell: startProcess(current, cwd, cols, rows).isPowerShell }
    } catch {
      return denied(
        'Could not start the local shell. Check that your shell and the Diffpane installation are available.',
      )
    } finally {
      current.prompt = undefined
    }
  }

  async function runCommand(command: TerminalCommand): Promise<BillySetupStartResult> {
    if (!canShow() || !window.isFocused()) return denied()
    if (commandPrompt || draining || surface?.prompt || surface?.stopping || (surface && !surface.loaded))
      return denied('Wait for the terminal to finish opening or stopping.')
    if (surface?.process) return denied('Stop the active terminal session before starting a Billy action.')
    const prompt = new AbortController()
    commandPrompt = prompt
    try {
      const original = await workspaceDirectory(command.cwd)
      if (prompt.signal.aborted || !canShow() || !window.isFocused()) return denied()
      const confirmed = await confirmTerminal(
        window.label,
        {
          title: 'Billy Company Diff',
          message: `Run ${command.label} in this checkout?`,
          detail: `${command.description}\n\n${command.display}\n${displayPath(command.cwd)}`,
          approve: 'Run in Terminal',
        },
        prompt.signal,
      )
      if (prompt.signal.aborted || !canShow()) return denied()
      if (!confirmed) return denied('Billy action canceled.')
      if (!surface && !(await open())) return denied()
      const current = surface
      const approved = await workspaceDirectory(command.cwd)
      if (prompt.signal.aborted || !canShow() || !current || surface !== current || !current.loaded) return denied()
      if (approved.dev !== original.dev || approved.ino !== original.ino)
        return denied('The Billy checkout changed. Reopen it before starting the action.')
      visibility(current, true)
      startProcess(current, command.cwd, terminalInitialColumns, terminalInitialRows, command)
      emitRenderer(current.label, 'terminal-command-started', command.label)
      return { ok: true }
    } catch {
      return denied('Could not start Igor in the terminal. Check your Billy setup and try again.')
    } finally {
      if (commandPrompt === prompt) commandPrompt = undefined
    }
  }

  async function open() {
    const label = `terminal-${++nextTerminal}`
    const current: Surface = {
      label,
      shown: false,
      loaded: false,
      focusOnShow: false,
      creating: hostRequest('terminal.create', window.label, label),
      ready: Promise.withResolvers<boolean>(),
      layoutWork: Promise.resolve(),
      layoutRevision: 0,
    }
    surface = current
    terminalViews.set(label, {
      async invoke(channel, [first, second]) {
        if (channel === 'terminal-ready') {
          current.ready.resolve(true)
          return
        }
        if (channel === 'terminal-start') return start(current, first, second)
        if (channel === 'terminal-stop' && (await keyboardTarget(current))) return stop(current)
        throw new Error('The terminal is unavailable.')
      },
      send(channel, [first, second]) {
        if (channel === 'terminal-input' && active(current) && window.isFocused()) current.process?.write(first)
        if (channel === 'terminal-resize' && active(current)) current.process?.resize(first, second)
        if (channel === 'terminal-ack') current.process?.acknowledge(first)
        if (channel === 'terminal-hide') visibility(current, false)
      },
      closed: reset,
    })
    visibility(current, true)
    const deadline = setTimeout(() => current.ready.resolve(false), 10_000)
    deadline.unref()
    try {
      await current.creating
      const ready = await current.ready.promise
      if (surface !== current) return false
      if (!ready) throw new Error('The terminal view did not finish loading.')
      current.loaded = true
      emitRenderer(label, 'terminal-theme', theme)
      emitRenderer(label, 'terminal-new-line-shortcut', newLineShortcut)
      syncLayout()
      return current.shown
    } catch {
      if (surface !== current) return false
      await reset()
      throw new Error('Could not open the terminal panel.')
    } finally {
      clearTimeout(deadline)
    }
  }

  return {
    runCommand,
    setNewLineShortcut(binding: ShortcutBinding) {
      if (newLineShortcut === binding) return
      newLineShortcut = binding
      if (surface?.loaded) emitRenderer(surface.label, 'terminal-new-line-shortcut', binding)
    },
    toggle() {
      if (!canShow()) return false
      if (!surface) return open()
      visibility(surface, !surface.shown)
      return surface.shown
    },
    layout(height: unknown, bottom: unknown, scheme: unknown) {
      if (!surface?.shown || !canShow()) return
      layout =
        typeof height === 'number' &&
        Number.isFinite(height) &&
        height > 0 &&
        height <= 600 &&
        typeof bottom === 'number' &&
        Number.isFinite(bottom) &&
        bottom >= 0 &&
        bottom <= 86
          ? { height, bottom }
          : undefined
      if ((scheme === 'light' || scheme === 'dark') && scheme !== theme) {
        theme = scheme
        if (surface.loaded) emitRenderer(surface.label, 'terminal-theme', theme)
      }
      syncLayout()
    },
    reset,
  }
}
