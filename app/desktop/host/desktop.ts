import { EventEmitter } from 'node:events'
import { handleHost, hostEvent, hostRequest, notifyHost } from './transport.ts'

export { handleHost, hostEvent, hostRequest } from './transport.ts'

interface DesktopOptions {
  version: string
  appPath: string
  profilePath: string
  logsPath: string
  targets: string[]
  mediaOrigin: string
  isPackaged: boolean
  legacyPreferences?: unknown
}

let configuration: DesktopOptions | undefined

function validOptions(options: unknown): options is DesktopOptions {
  return (
    typeof options === 'object' &&
    options !== null &&
    'version' in options &&
    typeof options.version === 'string' &&
    'appPath' in options &&
    typeof options.appPath === 'string' &&
    'profilePath' in options &&
    typeof options.profilePath === 'string' &&
    'logsPath' in options &&
    typeof options.logsPath === 'string' &&
    'mediaOrigin' in options &&
    typeof options.mediaOrigin === 'string' &&
    'isPackaged' in options &&
    typeof options.isPackaged === 'boolean' &&
    'targets' in options &&
    Array.isArray(options.targets) &&
    options.targets.every(target => typeof target === 'string')
  )
}

export function initializeDesktop(input: unknown) {
  if (!validOptions(input)) throw new Error('Diffpane received invalid desktop configuration.')
  configuration = input
}

export function desktopOptions(): DesktopOptions {
  if (!configuration) throw new Error('Diffpane desktop host is unavailable.')
  return configuration
}

export function reportHostError(error: unknown) {
  console.error('Diffpane desktop:', error instanceof Error ? error.message : 'Desktop I/O failed.')
}

export function emitRenderer(label: string, channel: string, ...args: unknown[]): void {
  const omitted: number[] = []
  const encoded = args.map((value, index) => {
    if (value !== undefined) return value
    omitted.push(index)
    return null
  })
  notifyHost('renderer-event', label, channel, encoded, omitted.length ? omitted : null)
}

class CloseRequest {
  defaultPrevented = false

  preventDefault() {
    this.defaultPrevented = true
  }
}

export const desktopApp = new (class extends EventEmitter<{
  'open-file': [event: CloseRequest, filename: string]
  'window-focused': [window: WorkspaceWindow]
  activate: []
  'before-quit': [event: CloseRequest]
  'window-all-closed': []
  'will-quit': [event: CloseRequest]
}> {
  quit() {
    const request = new CloseRequest()
    this.emit('before-quit', request)
    if (request.defaultPrevented) return
    this.emit('will-quit', request)
    if (!request.defaultPrevented) this.exit(0)
  }

  exit(code: number) {
    void hostRequest('app.exit', code).catch(reportHostError)
  }
})()

interface WindowOptions {
  width: number
  height: number
  minWidth: number
  minHeight: number
  title: string
  backgroundColor: string
}

let nextWindow = 0
let focusedWindow: WorkspaceWindow | null = null
const windows = new Map<string, WorkspaceWindow>()

export class WorkspaceRenderer extends EventEmitter<{
  navigation: []
  crashed: [reason: string]
}> {
  readonly id: number
  readonly #window: WorkspaceWindow
  loading = true

  constructor(id: number, window: WorkspaceWindow) {
    super()
    this.id = id
    this.#window = window
  }

  send(channel: string, ...args: unknown[]) {
    emitRenderer(this.#window.label, channel, ...args)
  }

  isDestroyed() {
    return this.#window.isDestroyed()
  }

  isLoading() {
    return this.loading
  }

  focus() {
    this.#window.focus()
  }

  setIgnoreMenuShortcuts(ignored: boolean) {
    void hostRequest('window.shortcuts', this.#window.label, ignored).catch(reportHostError)
  }
}

export class WorkspaceWindow extends EventEmitter<{ close: [event: CloseRequest]; closed: []; blur: [] }> {
  readonly label: string
  readonly renderer: WorkspaceRenderer
  readonly #options: WindowOptions
  #created = false
  #closed = false

  constructor(options: WindowOptions) {
    super()
    const id = ++nextWindow
    this.label = `workspace-${id}`
    this.renderer = new WorkspaceRenderer(id, this)
    this.#options = options
    windows.set(this.label, this)
  }

  static getFocusedWindow() {
    return focusedWindow
  }

  static getAllWindows() {
    return Array.from(windows.values())
  }

  static fromRenderer(renderer: WorkspaceRenderer) {
    return windows.get(`workspace-${renderer.id}`) ?? null
  }

  async load() {
    this.renderer.loading = true
    if (this.#created) await hostRequest('window.reload', this.label)
    else {
      this.#created = true
      try {
        await hostRequest('window.create', this.label, this.#options)
      } catch (error) {
        this.#created = false
        throw error
      }
    }
  }

  isDestroyed() {
    return this.#closed
  }

  isFocused() {
    return focusedWindow === this
  }

  focus() {
    void hostRequest('window.focus', this.label).catch(reportHostError)
  }

  close() {
    if (this.#closed) return
    const request = new CloseRequest()
    this.emit('close', request)
    if (request.defaultPrevented) return
    if (this.#created) void hostRequest('window.close', this.label).catch(reportHostError)
    else this.didClose()
  }

  didClose() {
    if (this.#closed) return
    this.#closed = true
    windows.delete(this.label)
    if (focusedWindow === this) focusedWindow = null
    this.emit('closed')
    if (windows.size === 0) desktopApp.emit('window-all-closed')
  }
}

function windowEvent(name: string, run: (window: WorkspaceWindow, value: unknown) => void) {
  hostEvent(name, (label, value) => {
    const window = typeof label === 'string' ? windows.get(label) : undefined
    if (window) run(window, value)
  })
}

windowEvent('window.close-requested', window => window.close())
windowEvent('window.closed', window => window.didClose())
windowEvent('window.focused', (window, focused) => {
  if (focused === true) {
    focusedWindow = window
    desktopApp.emit('window-focused', window)
  } else {
    if (focusedWindow === window) focusedWindow = null
    window.emit('blur')
  }
})
windowEvent('window.navigation', window => {
  window.renderer.loading = true
  window.renderer.emit('navigation')
})
windowEvent('window.crashed', (window, reason) => {
  if (typeof reason === 'string') window.renderer.emit('crashed', reason)
})
hostEvent('app.open-file', filename => {
  if (typeof filename !== 'string') return
  if (!desktopApp.emit('open-file', new CloseRequest(), filename)) desktopOptions().targets.push(filename)
})
hostEvent('app.activate', () => desktopApp.emit('activate'))
hostEvent('app.exit-requested', () => desktopApp.quit())

export interface RendererRequest {
  sender: WorkspaceRenderer
}

type RendererHandler = (request: RendererRequest, ...args: unknown[]) => unknown
type SurfaceDispatch = (label: string, channel: string, args: unknown[]) => unknown
const invokes = new Map<string, RendererHandler>()
const sends = new Map<string, RendererHandler>()

export const desktopBridge = {
  handle(channel: string, handler: RendererHandler) {
    if (invokes.has(channel)) throw new Error(`Duplicate workspace handler: ${channel}`)
    invokes.set(channel, handler)
  },
  on(channel: string, handler: RendererHandler) {
    if (sends.has(channel)) throw new Error(`Duplicate workspace event: ${channel}`)
    sends.set(channel, handler)
  },
}

export function routeRenderer(terminal: { invoke: SurfaceDispatch; send: SurfaceDispatch }) {
  for (const method of ['invoke', 'send'] as const) {
    const handlers = method === 'invoke' ? invokes : sends
    handleHost(method, (label, channel, args, undefinedArgs) => {
      if (typeof label !== 'string' || typeof channel !== 'string' || !Array.isArray(args))
        throw new Error('Invalid Diffpane bridge request.')
      if (Array.isArray(undefinedArgs)) {
        for (const index of undefinedArgs as unknown[]) {
          if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= args.length)
            throw new Error('Invalid Diffpane bridge arguments.')
          args[index] = undefined
        }
      }
      const input: unknown[] = args
      if (/^terminal-\d+$/.test(label)) return terminal[method](label, channel, input)
      const window = windows.get(label)
      const handler = handlers.get(channel)
      if (!window || !handler) throw new Error('This Diffpane window or operation is unavailable.')
      return handler({ sender: window.renderer }, ...input)
    })
  }
}
