// MONOLITHIC: Desktop window registration, worker ownership, save flushing and application shutdown share the session registry. Extract IPC families once their session and shutdown boundaries can be tested independently.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import {
  desktopApp as app,
  desktopBridge,
  desktopOptions,
  handleHost,
  hostEvent,
  routeRenderer,
  WorkspaceWindow,
} from '../../../desktop/host/desktop.ts'
import { updateNativeMenu } from '../../../desktop/services/menu.ts'
import { clipboard, dialog, shell, showError } from '../../../desktop/services/shell.ts'
import { colorHex } from '../../../shared/appearance/palette.ts'
import { createDiagnostics, parseDiagnostic } from '../../../shared/diagnostics/diagnostics.ts'
import { rendererOperations } from '../../../shared/diagnostics/renderer-operations.ts'
import { fileMenuLabels, isFileMenuAction } from '../../../shared/preferences/file-menu.ts'
import { effectiveBinding, isShortcutAction, shortcuts } from '../../../shared/preferences/shortcuts.ts'
import { appError, attempt, attemptAsync, serializeAppError } from '../../../shared/recovery/app-errors.ts'
import { formatReviewHandoff } from '../../../shared/review/review-notes.ts'
import { LocalState } from '../../persistence/database/local-state.ts'
import { localStateKeys } from '../../persistence/database/secure-storage.mjs'
import {
  isSetupStep,
  parseOnboardingAppearance,
  parseOnboardingState,
  readOnboarding,
  writeOnboarding,
} from '../../persistence/preferences/onboarding.ts'
import { RecentTargets } from '../../persistence/preferences/recent-targets.ts'
import { SavedWorkspaces } from '../../persistence/preferences/saved-workspaces.ts'
import { ShortcutPreferences } from '../../persistence/preferences/shortcut-preferences.ts'
import {
  applyUiPreferencePatch,
  parseUiPreference,
  parseUiPreferencePatch,
  parseUiPreferences,
  uiPreferenceKeys,
} from '../../persistence/preferences/ui-preferences.ts'
import { IdeaStore } from '../../persistence/project/idea-store.ts'
import { ReviewNotesStore } from '../../persistence/project/review-notes.ts'
import { AgentThreads } from '../../tools/assistant/agent-threads/threads.ts'
import { ClaudeCredentials } from '../../tools/assistant/claude-credentials.mjs'
import { ClaudeSession } from '../../tools/assistant/claude-session.mjs'
import { searchClaudeGist } from '../../tools/assistant/gist-search.mjs'
import { prepareBillySetup, registerBillyReview, resetBillyReview } from '../../tools/billy/bridge.ts'
import { Repository } from '../../workspace/repository/repository.mjs'
import { sampleAgentMemory } from '../diagnostics/agent-memory.ts'
import { startDesktopMetrics } from '../diagnostics/desktop-metrics.ts'
import { createDiagnosticLog } from '../diagnostics/diagnostic-log.ts'
import { createTerminalDock, dispatchTerminalInvoke, dispatchTerminalSend } from '../terminal/dock.ts'
import { pickNativePaths } from './open-picker.ts'
import { installWorkspaceMenu } from './workspace-menu.ts'
import { WorkspaceWindows } from './workspace-windows.ts'

/** @import { RendererRequest, WorkspaceRenderer } from '../../../desktop/host/desktop.ts' */
/** @import { SaveDialogOptions } from '../../../desktop/services/shell.ts' */
/** @import { MenuItemOptions } from '../../../desktop/services/menu.ts' */
/** @import { OpenKind, OpenPickerKind } from './open-picker.ts' */
/** @import { WorkspaceNavigation } from './workspace-windows.ts' */
/** @import { SessionLaunch } from '../session/session-protocol.ts' */
/** @import { AppError } from '../../../shared/recovery/app-errors.ts' */
/** @import { IdeaChange } from '../../../shared/ideas/ideas.ts' */
/** @import { FileMenuAction } from '../../../shared/preferences/file-menu.ts' */
/** @import { ShortcutOverrides } from '../../../shared/preferences/shortcuts.ts' */
/** @typedef {{root: string, scope: string}} WorkspaceLocation */
/** @typedef {{root: string, path: string, type: string}} WorkspaceMedia */
/** @typedef {{resolve: (value: unknown) => void, reject: (error: unknown) => void}} WorkerRequest */
/** @typedef {{directory: string | null, workspace?: WorkspaceNavigation['workspace'], contents: WorkspaceRenderer, claude: ClaudeSession, mediaToken: string, hasPendingSaves: boolean, rendererReady: boolean, settingsRequested: boolean, repositoryRoot?: string, repositoryScope?: string, flushing?: {id: number, promise: Promise<boolean>}, finishFlush?: (success: boolean) => void, stopping?: Promise<void>, restarting?: Promise<unknown>, root: () => Promise<string>, reviewWorkspace: () => Promise<WorkspaceLocation>, flush: () => Promise<boolean>, call: (method: string, args?: readonly unknown[]) => Promise<unknown>, restart: () => Promise<unknown>, announceFatal: () => void, stop: () => Promise<void>, canNavigate: () => boolean, navigate: (target: WorkspaceNavigation) => void, resume: () => void}} WindowSession */

const {
  profilePath,
  logsPath,
  targets: launchTargets,
  mediaOrigin,
  version: appVersion,
  legacyPreferences,
} = desktopOptions()
/** @type {Set<string>} */
const invokeChannels = new Set()
/** @type {Map<number, WindowSession>} */
const sessions = new Map()
/** @type {WeakMap<WindowSession, ReadonlySet<FileMenuAction>>} */
const fileMenuActions = new WeakMap()
/** @type {WeakMap<WindowSession, Map<string, {filePath: string, originalPath: string, path: string, identity: string}>>} */
const trashedEntries = new WeakMap()
/** @type {WeakMap<WindowSession, ReturnType<typeof createTerminalDock>>} */
const terminals = new WeakMap()
/** @type {WeakMap<WindowSession, AgentThreads>} */
const agentThreads = new WeakMap()
/** @type {WeakMap<WindowSession, number>} */
const rendererNavigationStarts = new WeakMap()
/** @type {Map<string, WindowSession>} */
const mediaSessions = new Map()
/** @type {Map<string, Promise<unknown>>} */
const fileChanges = new Map()
let nextRequest = 0
let nextFlush = 0
/** @type {'running' | 'flushing' | 'draining' | 'quitting'} */
let quitPhase = 'running'
/** @type {Set<Promise<void>>} */
const shutdowns = new Set()
/** @type {string[]} */
const pendingOpenPaths = []
let activated = false
const diagnosticDirectory = attempt(() => path.join(logsPath, 'diagnostics'))
const diagnosticLog = diagnosticDirectory.ok
  ? createDiagnosticLog(diagnosticDirectory.value, { appVersion })
  : undefined
if (!diagnosticLog) console.warn('Diffpane could not open its local diagnostic log directory.')
const diagnostics = createDiagnostics('main', event => diagnosticLog?.record(event))
/** @type {(() => void) | undefined} */
let stopDesktopMetrics
diagnostics.event('app-start')
process.on('uncaughtExceptionMonitor', cause => {
  createDiagnostics('main', event => diagnosticLog?.recordFatal(event)).error('uncaught-main-error', cause)
})
// Keep the native watcher library loaded while worker teardown joins its native threads.
const watcherLoad = attempt(
  () => {
    createRequire(import.meta.url)('@parcel/watcher')
  },
  { code: 'WATCHER_UNAVAILABLE' },
)
if (!watcherLoad.ok) diagnostics.error('watcher-load', watcherLoad.error)
const localStatePath = path.join(profilePath, 'state', 'local.sqlite')
let pendingLegacyPreferences = parseUiPreferences(legacyPreferences)
const existingProfile =
  existsSync(localStatePath) ||
  existsSync(path.join(profilePath, 'recent-targets.json')) ||
  Object.keys(pendingLegacyPreferences).length > 0
const localState = new LocalState(localStatePath, localStateKeys)
/** @type {WindowSession | undefined} */
let onboardingOwner
const shortcutPreferences = new ShortcutPreferences(localState, path.join(profilePath, 'shortcuts.sqlite'))
/** @type {ShortcutOverrides} */
let shortcutOverrides = {}
let shortcutUpdates = Promise.resolve()
const isMac = process.platform === 'darwin'
/** @type {WeakSet<WorkspaceRenderer>} */
const capturingShortcuts = new WeakSet()
/** @type {WeakSet<WorkspaceRenderer>} */
const modalWindows = new WeakSet()
const claudeCredentials = new ClaudeCredentials(path.join(profilePath, 'claude-key'))
const ideaStore = new IdeaStore(localState, path.join(profilePath, 'ideas.sqlite'))
const reviewNotes = new ReviewNotesStore(localState, path.join(profilePath, 'review-notes', 'notes.sqlite'))
let reviewNoteUpdates = Promise.resolve()
const recentTargets = new RecentTargets(localState, path.join(profilePath, 'recent-targets.json'), error =>
  logError(error, 'recent-targets-storage'),
)
let recentUpdates = Promise.resolve()
let preferenceUpdates = Promise.resolve()
let preferenceRevision = 0
/** @type {Set<Promise<unknown>>} */
const storageOperations = new Set()
/** @type {Set<Promise<unknown>>} */
const mutationOperations = new Set()
const workspaceWindows = new WorkspaceWindows(new SavedWorkspaces(localState), {
  changed: () => {
    for (const session of sessions.values()) if (session.rendererReady) send(session.contents, 'workspaces-changed')
  },
  track: pending => trackOperation(storageOperations, pending),
  log: error => logError(error, 'workspaces-storage'),
})

/** @template T @param {Set<Promise<unknown>>} operations @param {Promise<T>} pending */
async function trackOperation(operations, pending) {
  operations.add(pending)
  try {
    return await pending
  } finally {
    operations.delete(pending)
  }
}

/** @param {unknown} error @param {string} operation */
function logError(error, operation) {
  diagnostics.error(operation, error)
}

/** @param {string} operation @param {() => unknown} run @param {(error: AppError) => unknown} [onError] */
async function background(operation, run, onError) {
  const startedAt = performance.now()
  const result = await attemptAsync(run, { operation })
  diagnostics.measure(`background.${operation}`, startedAt, result)
  if (result.ok) return
  if (!onError) return
  const recovery = await attemptAsync(() => onError(result.error))
  if (!recovery.ok) logError(recovery.error, operation)
}

/** @param {string} operation @param {() => unknown} run @param {(error: AppError) => unknown} [onError] */
function runBackground(operation, run, onError) {
  background(operation, run, onError).catch((/** @type {unknown} */ cause) => logError(cause, operation))
}

/** @param {WorkspaceRenderer} contents @param {string} channel @param {unknown[]} args */
function send(contents, channel, ...args) {
  if (contents.isDestroyed()) return false
  const result = attempt(() => contents.send(channel, ...args), { operation: channel })
  if (!result.ok) logError(result.error, channel)
  return result.ok
}

/** @param {RendererRequest} event */
function sessionFor(event) {
  const session = sessions.get(event.sender.id)
  if (!session || session.contents !== event.sender)
    throw appError('This Diffpane window is no longer available.', { code: 'WINDOW_UNAVAILABLE' })
  return session
}

/** @param {unknown} value @returns {WorkspaceLocation | undefined} */
function workspaceLocation(value) {
  if (
    typeof value === 'object' &&
    value !== null &&
    'root' in value &&
    typeof value.root === 'string' &&
    'scope' in value &&
    typeof value.scope === 'string'
  )
    return { root: value.root, scope: value.scope }
  return undefined
}

/** @param {unknown} value @returns {WorkspaceMedia} */
function workspaceMedia(value) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('root' in value) ||
    typeof value.root !== 'string' ||
    !('path' in value) ||
    typeof value.path !== 'string' ||
    !('type' in value) ||
    typeof value.type !== 'string'
  )
    throw new Error('Invalid workspace media response.')
  return { root: value.root, path: value.path, type: value.type }
}

/**
 * @param {string} channel
 * @param {(session: WindowSession, event: RendererRequest, ...args: unknown[]) => unknown} listener
 * @param {{minimumSuccessMs?: number}} [options]
 */
function handle(channel, listener, { minimumSuccessMs = 0 } = {}) {
  invokeChannels.add(channel)
  desktopBridge.handle(channel, async (event, ...args) => {
    const startedAt = performance.now()
    const windowId = event.sender.id
    const result = await attemptAsync(
      () => {
        if (quitPhase === 'draining' || quitPhase === 'quitting')
          throw appError('Diffpane is closing.', { code: 'WINDOW_UNAVAILABLE' })
        return listener(sessionFor(event), event, ...args)
      },
      {
        operation: channel,
      },
    )
    if (!result.ok || performance.now() - startedAt >= minimumSuccessMs)
      windowDiagnostics(windowId).measure(`ipc.${channel}`, startedAt, result)
    if (result.ok) return result
    return { ok: false, error: serializeAppError(result.error) }
  })
}

/** @param {string} channel @param {(session: WindowSession, ...args: unknown[]) => void} listener */
function onRenderer(channel, listener) {
  desktopBridge.on(channel, (event, ...args) => {
    const startedAt = performance.now()
    const result = attempt(() => listener(sessionFor(event), ...args), { operation: channel })
    if (result.ok || result.error.code !== 'WINDOW_UNAVAILABLE')
      windowDiagnostics(event.sender.id).measure(`ipc.${channel}`, startedAt, result)
  })
}

/** @param {number} windowId */
function windowDiagnostics(windowId) {
  return createDiagnostics('main', event => diagnosticLog?.record(event, { windowId }))
}

/** @type {WeakMap<WindowSession, {until: number, ordinary: number, important: number}>} */
const rendererDiagnosticBudgets = new WeakMap()
/** @param {WindowSession} session @param {boolean} important */
function allowRendererDiagnostic(session, important) {
  const now = performance.now()
  let budget = rendererDiagnosticBudgets.get(session)
  if (!budget || budget.until <= now) {
    budget = { until: now + 10_000, ordinary: 240, important: 60 }
    rendererDiagnosticBudgets.set(session, budget)
  }
  const key = important ? 'important' : 'ordinary'
  if (budget[key] <= 0) return false
  budget[key]--
  return true
}

desktopBridge.on('renderer-diagnostic', (event, value) => {
  const owner = attempt(() => sessionFor(event))
  if (!owner.ok || !diagnosticLog) return
  const record = parseDiagnostic(value, 'renderer')
  if (
    record &&
    rendererOperations.has(record.operation) &&
    allowRendererDiagnostic(owner.value, record.level !== 'info')
  )
    diagnosticLog.record(record, { windowId: event.sender.id })
})
desktopBridge.on(
  'bridge-diagnostic',
  (event, /** @type {unknown} */ channel, /** @type {unknown} */ durationMs, /** @type {unknown} */ code) => {
    const owner = attempt(() => sessionFor(event))
    if (!owner.ok || !diagnosticLog || typeof channel !== 'string' || !invokeChannels.has(channel)) return
    if (code !== 'INVALID_IPC_RESPONSE' && code !== 'IPC_UNAVAILABLE') return
    const record = parseDiagnostic(
      {
        source: 'bridge',
        kind: 'duration',
        level: 'error',
        operation: `bridge.${channel}`,
        durationMs,
        outcome: 'failure',
        failure: { code, recoverable: true },
      },
      'bridge',
    )
    if (record && allowRendererDiagnostic(owner.value, true))
      diagnosticLog.record(record, { windowId: event.sender.id })
  },
)

/** @param {string} operation @param {() => unknown} run */
function windowAction(operation, run) {
  if (quitPhase !== 'running') return
  runBackground(operation, run, error => showError('Diffpane could not complete that action', error.message))
}

/** @param {string} target */
function rememberTarget(target) {
  if (quitPhase === 'draining' || quitPhase === 'quitting') return
  recentUpdates = recentUpdates.then(() => background('record-recent-target', () => recentTargets.record(target)))
  runBackground('record-recent-target', () => trackOperation(storageOperations, recentUpdates))
}

/** @template T @param {WindowSession} session @param {readonly string[]} files @param {() => Promise<T>} change */
function changeFiles(session, files, change) {
  return trackOperation(
    mutationOperations,
    session.root().then(async root => {
      const keys = [...new Set(files.map(file => path.resolve(root, file)))]
      const previous = keys.flatMap(key => {
        const operation = fileChanges.get(key)
        return operation ? [operation] : []
      })
      const pending = (async () => {
        await Promise.allSettled(previous)
        return change()
      })()
      for (const key of keys) fileChanges.set(key, pending)
      try {
        return await pending
      } finally {
        for (const key of keys) if (fileChanges.get(key) === pending) fileChanges.delete(key)
      }
    }),
  )
}

/** @param {string | null} [directory] @param {Pick<SessionLaunch, 'initialFile' | 'initialLine'>} [initial] */
function createWindow(directory = null, { initialFile, initialLine } = {}) {
  const windowStartedAt = performance.now()
  const window = new WorkspaceWindow({
    width: 1400,
    height: 960,
    minWidth: 650,
    minHeight: 420,
    title: directory ? `${path.basename(directory)} · Diffpane` : 'Diffpane',
    backgroundColor: colorHex('dark', 'canvas'),
  })
  const windowId = window.renderer.id
  const scoped = windowDiagnostics(windowId)
  scoped.measure('window-create', windowStartedAt)
  /** @type {Worker | undefined} */
  let worker
  /** @type {Promise<void>} */
  let workerExited = Promise.resolve()
  /** @type {Map<number, WorkerRequest>} */
  const requests = new Map()
  let versions = { revision: 0, catalogRevision: 0, reviewVersion: 0, checkpointId: 0 }
  let changingWorkspace = false
  /** @type {string | undefined} */
  let rememberedFile
  /** @type {AppError | undefined} */
  let fatal
  let remembered = false
  /** @type {Set<number>} */
  const languageProcesses = new Set()
  function killLanguageProcesses() {
    for (const pid of languageProcesses) {
      try {
        if (process.platform === 'win32') process.kill(pid)
        else process.kill(-pid, 'SIGKILL')
      } catch {
        /* An owned server has already stopped. */
      }
    }
    languageProcesses.clear()
  }
  /** @param {unknown} cause */
  function fail(cause) {
    if (fatal) return
    fatal = appError(cause, {
      code: 'BACKEND_UNAVAILABLE',
      operation: 'workspace-worker',
      recoverable: false,
    })
    scoped.error('workspace-worker', fatal)
    killLanguageProcesses()
    runBackground('stop-terminal', () => terminal.reset())
    for (const request of requests.values()) request.reject(fatal)
    requests.clear()
    session.finishFlush?.(false)
    if (session.rendererReady) send(session.contents, 'backend-error', serializeAppError(fatal))
  }

  /** @param {unknown} message */
  function receive(message) {
    if (typeof message !== 'object' || message === null) throw new Error('Invalid workspace worker message.')
    if ('event' in message) {
      if (message.event === 'error' && 'failure' in message) {
        if (!changingWorkspace || session.rendererReady)
          send(session.contents, 'backend-error', serializeAppError(message.failure))
        return
      }
      if (!('value' in message)) throw new Error('Invalid workspace worker event.')
      const { value } = message
      if (message.event === 'diagnostic') {
        const record = parseDiagnostic(value, 'workspace')
        if (record) diagnosticLog?.record(record, { windowId })
        return
      }
      if (message.event === 'change') {
        const location = workspaceLocation(value)
        if (!location) throw new Error('Invalid workspace snapshot location.')
        if ('versions' in message && typeof message.versions === 'object' && message.versions !== null) {
          for (const key of ['revision', 'catalogRevision', 'reviewVersion', 'checkpointId']) {
            const version = /** @type {unknown} */ (Reflect.get(message.versions, key))
            if (typeof version === 'number' && Number.isSafeInteger(version) && version >= 0)
              Reflect.set(versions, key, version)
          }
        }
        session.repositoryRoot = location.root
        session.repositoryScope = location.scope
        if (!remembered && directory && !session.workspace) {
          remembered = true
          rememberTarget(initialFile ?? directory)
        }
      }
      if (
        (message.event === 'language-event' || message.event === 'howmany-event') &&
        typeof value === 'object' &&
        value !== null &&
        'type' in value &&
        value.type === 'process' &&
        'status' in value &&
        'pid' in value &&
        typeof value.pid === 'number' &&
        Number.isSafeInteger(value.pid) &&
        value.pid > 0
      ) {
        const { status, pid } = value
        if (status === 'started') languageProcesses.add(pid)
        if (status === 'stopped') languageProcesses.delete(pid)
      }
      if (
        (!changingWorkspace || session.rendererReady) &&
        (message.event === 'change' ||
          message.event === 'git-change' ||
          message.event === 'language-event' ||
          message.event === 'howmany-event' ||
          message.event === 'paths')
      )
        send(session.contents, message.event, value)
    } else if ('id' in message && typeof message.id === 'number') {
      const request = requests.get(message.id)
      if (request) {
        requests.delete(message.id)
        if ('failure' in message) request.reject(appError(message.failure))
        else if ('error' in message) request.reject(appError(message.error))
        else if ('value' in message) request.resolve(message.value)
        else request.reject(new Error('Invalid workspace worker response.'))
      }
    }
  }

  function startWorker() {
    fatal = undefined
    const startedAt = performance.now()
    const result = attempt(
      () =>
        new Worker(new URL('../session/session.mjs', import.meta.url), {
          workerData: { directory, versions, initialFile, initialLine, rememberedFile },
        }),
    )
    if (!result.ok) {
      scoped.measure('workspace-worker-online', startedAt, result)
      fail(result.error)
      return
    }
    const current = (worker = result.value)
    current.once('online', () => scoped.measure('workspace-worker-online', startedAt))
    workerExited = new Promise(resolve => {
      current.once('exit', () => resolve())
    })
    current.on('error', error => {
      if (worker === current) fail(error)
    })
    current.on('exit', code => {
      if (worker === current && !session.stopping && !window.isDestroyed())
        fail(new Error(`The workspace worker exited (${code}).`))
    })
    current.on('message', message => {
      if (worker !== current || fatal) return
      const received = attempt(() => receive(message))
      if (!received.ok) scoped.error('receive-workspace-message', received.error)
    })
    current.on('messageerror', error => {
      if (worker === current) {
        fail(error)
        runBackground('terminate-workspace-worker', () => current.terminate())
      }
    })
  }

  /** @type {WindowSession} */
  const session = {
    directory,
    contents: window.renderer,
    claude: new ClaudeSession(scoped),
    mediaToken: randomUUID(),
    hasPendingSaves: false,
    rendererReady: false,
    settingsRequested: false,
    async root() {
      this.repositoryRoot ??= workspaceLocation(await this.call('snapshot'))?.root
      if (!this.repositoryRoot) throw appError('Open a file or folder first.', { code: 'WORKSPACE_REQUIRED' })
      return this.repositoryRoot
    },
    async reviewWorkspace() {
      if (!this.repositoryScope) {
        const snapshot = workspaceLocation(await this.call('snapshot'))
        this.repositoryRoot = snapshot?.root
        this.repositoryScope = snapshot?.scope
      }
      if (!this.repositoryRoot || !this.repositoryScope)
        throw appError('Open a file or folder first.', { code: 'WORKSPACE_REQUIRED' })
      return { root: this.repositoryRoot, scope: this.repositoryScope }
    },
    flush() {
      // Startup and empty windows have no editable buffers to flush. Their close
      // action must not depend on a worker or a renderer that failed to initialize.
      if (window.isDestroyed()) return Promise.resolve(true)
      if (this.stopping && !this.hasPendingSaves) return Promise.resolve(true)
      const unavailable =
        fatal !== undefined || !this.rendererReady || window.renderer.isDestroyed() || window.renderer.isLoading()
      if (!this.hasPendingSaves && unavailable) return Promise.resolve(true)
      if (unavailable) return Promise.resolve(false)
      // A healthy project renderer also freezes clean editors, preventing new
      // edits while application quit waits for workers to finish shutting down.
      if (!this.flushing) {
        const startedAt = performance.now()
        const id = ++nextFlush
        const promise = new Promise(
          /** @type {(resolve: (success: boolean) => void) => void} */ (
            resolve => {
              const timer = setTimeout(() => this.finishFlush?.(false), 5000)
              this.finishFlush = (/** @type {boolean} */ success) => {
                clearTimeout(timer)
                if (success) scoped.measure('flush-saves', startedAt)
                else
                  scoped.measure('flush-saves', startedAt, {
                    ok: false,
                    error: appError('Save flush failed.', { code: 'SAVE_FLUSH_FAILED' }),
                  })
                this.flushing = undefined
                this.finishFlush = undefined
                if (success) this.hasPendingSaves = false
                resolve(success)
              }
            }
          ),
        )
        this.flushing = { id, promise }
        if (!send(this.contents, 'flush-saves', id)) this.finishFlush?.(false)
        return promise
      }
      return this.flushing.promise
    },
    call(method, args = []) {
      if (this.stopping) return Promise.reject(appError('This window is closing.', { code: 'WINDOW_UNAVAILABLE' }))
      if (changingWorkspace && !this.rendererReady && method !== 'language-dispose')
        return Promise.reject(appError('This window is changing folders.', { code: 'WORKSPACE_NAVIGATION_PENDING' }))
      if (fatal) return Promise.reject(fatal)
      const current = worker
      if (!current)
        return method === 'snapshot'
          ? Promise.resolve(null)
          : Promise.reject(appError('Open a file or folder first.', { code: 'WORKSPACE_REQUIRED' }))
      const id = ++nextRequest
      const startedAt = performance.now()
      return new Promise((resolve, reject) => {
        requests.set(id, {
          resolve(value) {
            scoped.measure(`worker-roundtrip.${method}`, startedAt, { ok: true }, { requestId: id })
            resolve(value)
          },
          reject(error) {
            scoped.measure(`worker-roundtrip.${method}`, startedAt, { ok: false, error }, { requestId: id })
            reject(error)
          },
        })
        try {
          current.postMessage({ id, method, args })
        } catch (error) {
          requests.get(id)?.reject(error)
          requests.delete(id)
        }
      })
    },
    restart() {
      if (this.restarting) return this.restarting
      if (!directory || !fatal) return this.call('snapshot')
      this.restarting = (async () => {
        await workerExited
        if (this.stopping) return this.call('snapshot')
        worker = undefined
        startWorker()
        return this.call('snapshot')
      })().finally(() => {
        this.restarting = undefined
      })
      return this.restarting
    },
    announceFatal() {
      if (fatal) send(this.contents, 'backend-error', serializeAppError(fatal))
    },
    canNavigate() {
      return quitPhase === 'running' && !window.isDestroyed() && !allowClose && !changingWorkspace
    },
    navigate(target) {
      if (!this.canNavigate()) {
        this.resume()
        return
      }
      changingWorkspace = true
      this.rendererReady = false
      if (window.isFocused()) syncFileMenu(this)
      runBackground('change-workspace', async () => {
        try {
          // Send the IPC acknowledgement before starting to unload its renderer.
          await nextTurn()
          await background('stop-previous-workspace', () => this.stop())
          if (window.isDestroyed() || quitPhase === 'draining' || quitPhase === 'quitting') return
          worker = undefined
          fatal = undefined
          versions = { revision: 0, catalogRevision: 0, reviewVersion: 0, checkpointId: 0 }
          this.stopping = undefined
          this.restarting = undefined
          this.repositoryRoot = this.repositoryScope = undefined
          mediaSessions.delete(this.mediaToken)
          this.mediaToken = randomUUID()
          mediaSessions.set(this.mediaToken, this)
          directory = this.directory = target.directory
          this.workspace = target.workspace
          rememberedFile = target.rememberedFile
          initialFile = initialLine = undefined
          if (directory) startWorker()
          await loadWindow()
        } finally {
          changingWorkspace = false
        }
      })
    },
    resume() {
      send(this.contents, 'resume-editing')
    },
    stop() {
      if (this.stopping) return this.stopping
      resetBillyReview(this)
      this.claude.reset()
      this.stopping = (async () => {
        const terminalStopped = terminal.reset()
        if (!worker) return terminalStopped
        /** @type {NodeJS.Timeout | undefined} */
        let timer
        let graceful = false
        try {
          if (!fatal) {
            const disposed = this.call('language-dispose').then(
              () => workerExited,
              async (/** @type {unknown} */ error) => {
                if (!fatal) logError(error, 'dispose-workspace')
                await workerExited
              },
            )
            graceful = await Promise.race([
              disposed.then(() => true),
              new Promise(
                /** @type {(resolve: (success: boolean) => void) => void} */ (
                  resolve => {
                    timer = setTimeout(() => resolve(false), 2500)
                  }
                ),
              ),
            ])
          }
        } catch (error) {
          if (!fatal) logError(error, 'dispose-workspace')
        } finally {
          clearTimeout(timer)
          killLanguageProcesses()
          for (const request of requests.values())
            request.reject(appError('This window is closing.', { code: 'WINDOW_UNAVAILABLE' }))
          requests.clear()
          // Native watcher completion callbacks must drain in the worker's live
          // environment. Force termination is reserved for failed or stuck workers.
          if (!graceful) {
            scoped.event('workspace-worker-forced-stop', 'warn')
            await Promise.all([worker.terminate(), terminalStopped])
          } else {
            await terminalStopped
          }
        }
      })()
      const stopping = this.stopping
      shutdowns.add(stopping)
      runBackground('stop-workspace', async () => {
        try {
          await stopping
        } finally {
          shutdowns.delete(stopping)
        }
      })
      return this.stopping
    },
  }
  const terminal = createTerminalDock({
    window,
    eligible: () =>
      Boolean(directory && session.rendererReady && !fatal && !session.stopping && quitPhase === 'running'),
    workspace: async () => (await session.reviewWorkspace()).scope,
    onVisibility: visible => send(session.contents, 'terminal-visibility', visible),
  })
  terminal.setNewLineShortcut(effectiveBinding('terminalNewLine', shortcutOverrides, isMac))
  terminals.set(session, terminal)
  sessions.set(windowId, session)
  mediaSessions.set(session.mediaToken, session)
  const contents = window.renderer
  if (directory) startWorker()
  let allowClose = false
  window.on('close', event => {
    if (quitPhase === 'quitting' || allowClose) return
    event.preventDefault()
    if (quitPhase !== 'running') return
    runBackground(
      'close-window',
      async () => {
        const flushed = await session.flush()
        if (quitPhase !== 'running') return
        if (flushed && !window.isDestroyed()) {
          allowClose = true
          window.close()
        } else send(session.contents, 'resume-editing')
      },
      () => {
        if (quitPhase === 'running') send(session.contents, 'resume-editing')
      },
    )
  })
  window.on('closed', () => {
    resetBillyReview(session)
    agentThreads.get(session)?.clear()
    sessions.delete(windowId)
    mediaSessions.delete(session.mediaToken)
    session.finishFlush?.(true)
    runBackground('close-workspace', () => session.stop())
  })
  function detachRenderer() {
    resetBillyReview(session)
    const wasReady = session.rendererReady
    session.rendererReady = false
    fileMenuActions.delete(session)
    trashedEntries.delete(session)
    if (window.isFocused()) syncFileMenu(session)
    runBackground('stop-terminal', () => terminal.reset())
    session.claude.reset()
    agentThreads.get(session)?.clear()
    agentThreads.delete(session)
    session.finishFlush?.(false)
    if (directory && wasReady && !fatal)
      runBackground('cancel-workspace-search', () => session.call('content-search-cancel'))
    capturingShortcuts.delete(session.contents)
    modalWindows.delete(session.contents)
  }
  contents.on('navigation', () => {
    rendererNavigationStarts.set(session, performance.now())
    runBackground('detach-renderer', detachRenderer)
  })
  contents.on('crashed', reason => {
    rendererNavigationStarts.delete(session)
    scoped.event(`renderer-process-gone.${reason}`, reason === 'clean-exit' ? 'info' : 'error')
    const hadPendingSaves = session.hasPendingSaves
    session.hasPendingSaves = false
    runBackground('detach-renderer', detachRenderer)
    if (quitPhase === 'running' && reason !== 'clean-exit') {
      const error = appError(`The window stopped responding (${reason}).`, {
        code: 'RENDERER_UNAVAILABLE',
        operation: 'render-window',
      })
      scoped.error('render-window', error)
      runBackground('recover-window', () => offerWindowRecovery(error, { crashed: true, hadPendingSaves }))
    }
  })
  let recoveryOpen = false
  /** @param {AppError} error @param {{crashed?: boolean, hadPendingSaves?: boolean}} [state] */
  async function offerWindowRecovery(error, { crashed = false, hadPendingSaves = session.hasPendingSaves } = {}) {
    if (window.isDestroyed() || recoveryOpen) return
    recoveryOpen = true
    let response
    try {
      const choice = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Diffpane',
        message: 'This window needs to reload',
        detail: `${error.message}${hadPendingSaves ? '\n\nThis window had unsaved changes.' : ''}`,
        buttons: crashed ? ['Reload Window', 'Close Window', 'Cancel'] : ['Reload Window', 'Cancel'],
        defaultId: hadPendingSaves ? (crashed ? 2 : 1) : 0,
        cancelId: crashed ? 2 : 1,
      })
      response = choice.response
    } finally {
      recoveryOpen = false
    }
    if (window.isDestroyed()) return
    if (response === 0) await loadWindow()
    else if (crashed && response === 1) window.close()
  }
  function loadWindow() {
    return background(
      'load-window',
      () => window.load(),
      error => {
        if (error.code !== 'ERR_ABORTED') runBackground('recover-window', () => offerWindowRecovery(error))
      },
    )
  }
  runBackground('load-window', loadWindow)
  return window
}

/** @param {string} target @param {WorkspaceWindow | null} [source] @param {Pick<SessionLaunch, 'initialFile' | 'initialLine'>} [initial] */
function openTarget(target, source = WorkspaceWindow.getFocusedWindow(), initial) {
  const window = createWindow(path.resolve(target), initial)
  if (source && !source.isDestroyed() && sessions.get(source.renderer.id)?.directory === null) source.close()
  return window
}

function openSettings() {
  const window = WorkspaceWindow.getFocusedWindow() ?? WorkspaceWindow.getAllWindows()[0] ?? createWindow()
  window.focus()
  const session = sessions.get(window.renderer.id)
  if (!session) return
  if (session.rendererReady) send(session.contents, 'open-settings')
  else session.settingsRequested = true
}

/** @param {() => Promise<ShortcutOverrides>} read */
function updateShortcuts(read) {
  const result = shortcutUpdates.then(async () => {
    const overrides = await read()
    const changed = Object.keys(shortcuts)
      .filter(isShortcutAction)
      .filter(action => overrides[action] !== shortcutOverrides[action])
    if (changed.length) {
      shortcutOverrides = overrides
      if (changed.some(action => shortcuts[action].scope === 'native')) setApplicationMenu()
      for (const session of sessions.values()) {
        if (changed.includes('terminalNewLine'))
          terminals.get(session)?.setNewLineShortcut(effectiveBinding('terminalNewLine', overrides, isMac))
        if (session.rendererReady) send(session.contents, 'shortcuts-updated', overrides)
      }
    }
    return overrides
  })
  shortcutUpdates = result.then(
    () => undefined,
    () => undefined,
  )
  return trackOperation(storageOperations, result)
}

function refreshShortcuts() {
  return updateShortcuts(() => shortcutPreferences.get())
}

/** @type {AbortController | undefined} */
let openPicker

/** @param {WorkspaceWindow | null} window @param {OpenPickerKind} kind */
async function choosePaths(window, kind) {
  if (quitPhase !== 'running' || openPicker || window?.isDestroyed()) return []
  const picker = new AbortController()
  const abort = () => picker.abort()
  openPicker = picker
  window?.once('closed', abort)
  try {
    const selected = await pickNativePaths(window, kind, picker.signal)
    return quitPhase === 'running' ? selected : []
  } finally {
    window?.off('closed', abort)
    openPicker = undefined
  }
}

/** @param {WorkspaceWindow | null} window @param {OpenKind} kind */
async function chooseTarget(window, kind) {
  const [target] = await choosePaths(window, kind)
  if (!target || quitPhase !== 'running') return false
  openTarget(target, window)
  return true
}

// Finder can supply files before the first workspace opens.
app.on('open-file', (event, filename) => {
  event.preventDefault()
  if (activated) windowAction('open-file', () => openTarget(filename))
  else pendingOpenPaths.push(filename)
})

registerBillyReview(handle)
handle('billy-setup-run', async (session, event, action) => {
  const command = await prepareBillySetup(session, event, action)
  return (
    terminals.get(session)?.runCommand(command) ?? { ok: false, message: 'The terminal is unavailable in this window.' }
  )
})

handle('open-external', async (_session, _event, href) => {
  if (typeof href !== 'string') throw appError('This link cannot be opened.', { code: 'INVALID_LINK' })
  const parsed = attempt(() => new URL(href))
  if (!parsed.ok || !['https:', 'http:', 'mailto:'].includes(parsed.value.protocol))
    throw appError('This link cannot be opened.', { code: 'INVALID_LINK' })
  const url = parsed.value
  await shell.openExternal(url.href)
})

handle('media', async (session, _event, filePath) => {
  const media = workspaceMedia(await session.call('media', [filePath]))
  return {
    type: media.type,
    url: `${mediaOrigin}/media/workspace-${session.contents.id}/${session.mediaToken}/${encodeURIComponent(media.path)}?v=${++nextRequest}`,
  }
})

handleHost('media.resolve', async (label, token, filePath) => {
  const session = typeof token === 'string' ? mediaSessions.get(token) : undefined
  if (
    !session ||
    label !== `workspace-${session.contents.id}` ||
    session.contents.isDestroyed() ||
    typeof filePath !== 'string'
  )
    return null
  const result = await attemptAsync(() => session.call('media', [filePath]))
  return result.ok ? workspaceMedia(result.value) : null
})

/** @type {Record<string, (session: WindowSession, input: unknown) => unknown>} */
const claudeHandlers = {
  status: () => claudeCredentials.status(),
  'save-key': async (_session, key) => {
    if (typeof key !== 'string') throw new Error('Enter a valid API key.')
    const status = await claudeCredentials.save(key)
    resetClaudeSessions(status)
    return status
  },
  'remove-key': async () => {
    const status = await claudeCredentials.remove()
    resetClaudeSessions(status)
    return status
  },
  send: (session, input) => {
    if (!session.directory) throw new Error('Open a file or folder to ask about your project.')
    /** @type {import('../../tools/assistant/claude-session.mjs').ClaudeWorkspace['read']} */
    const read = async (filename, side) => {
      const text = await session.call('claude-read', [filename, side]).catch(() => {
        throw new Error('This project text file could not be read.')
      })
      if (typeof text !== 'string') throw new Error('This project text file could not be read.')
      return text
    }
    return session.claude.send(
      input,
      () => claudeCredentials.key(),
      {
        async list(query) {
          const value = await session.call('claude-list', [query])
          if (
            typeof value !== 'object' ||
            value === null ||
            !('paths' in value) ||
            !Array.isArray(value.paths) ||
            !('truncated' in value) ||
            typeof value.truncated !== 'boolean'
          ) {
            throw new Error('The project file list is unavailable.')
          }
          const entries = /** @type {unknown[]} */ (value.paths)
          const paths = entries.filter(filename => typeof filename === 'string')
          if (paths.length !== value.paths.length) throw new Error('The project file list is unavailable.')
          return { paths, truncated: value.truncated }
        },
        read,
        search: async (query, matchCase, signal) =>
          searchClaudeGist(
            await session.reviewWorkspace(),
            query,
            matchCase,
            signal,
            filename => read(filename, 'working'),
            undefined,
            (text, caseSensitive, searchSignal) => searchClaudeWorker(session, text, caseSensitive, searchSignal),
          ),
        async checkCreate(filename) {
          await session.call('claude-check-create', [filename])
        },
        listIdeas: async query => ideaStore.summaries(await session.root(), query),
        readIdea: async id => ideaStore.get(await session.root(), id),
      },
      activity => send(session.contents, 'claude-activity', activity),
    )
  },
  apply: (session, id) => {
    if (typeof id !== 'string') throw new Error('Invalid proposal.')
    return session.claude.apply(id, {
      saveFiles: changes =>
        changeFiles(
          session,
          changes.map(change => change.path),
          async () => {
            await session.call('claude-save-files', [changes])
          },
        ),
      saveIdea: async (idea, expected) => {
        const root = await session.root()
        const saved = await ideaStore.applyDraft(root, idea, expected)
        broadcastIdeaChange(root, null, { type: 'upsert', idea: saved })
        return saved
      },
    })
  },
  discard: (session, id) => {
    if (typeof id !== 'string') throw new Error('Invalid proposal.')
    return session.claude.discard(id)
  },
  reset: session => session.claude.reset(),
  cancel: session => session.claude.cancel(),
}

/** @param {WindowSession} session @param {string} query @param {boolean} matchCase @param {AbortSignal} signal */
async function searchClaudeWorker(session, query, matchCase, signal) {
  signal.throwIfAborted()
  const id = randomUUID()
  const cancel = () => void session.call('claude-search-cancel', [id]).catch(() => {})
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const value = await session.call('claude-search', [id, query, matchCase])
    if (
      value === null ||
      typeof value !== 'object' ||
      !('matches' in value) ||
      !Array.isArray(value.matches) ||
      !('truncated' in value) ||
      typeof value.truncated !== 'boolean'
    )
      throw new Error('The project text search is unavailable.')
    const matches = /** @type {unknown[]} */ (value.matches)
    if (!matches.every(isClaudeSearchMatch)) throw new Error('The project text search is unavailable.')
    return { matches, truncated: value.truncated }
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/** @param {unknown} value @returns {value is import('../../tools/assistant/gist-search.mjs').ClaudeSearchMatch} */
function isClaudeSearchMatch(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    'path' in value &&
    typeof value.path === 'string' &&
    'text' in value &&
    typeof value.text === 'string' &&
    'line' in value &&
    typeof value.line === 'number' &&
    'column' in value &&
    typeof value.column === 'number'
  )
}

/** @param {Awaited<ReturnType<ClaudeCredentials['status']>>} status */
function resetClaudeSessions(status) {
  for (const session of sessions.values()) {
    session.claude.reset()
    send(session.contents, 'claude-reset', status)
  }
}

for (const [method, handler] of Object.entries(claudeHandlers)) {
  handle(`claude-${method}`, (session, _event, input) => {
    if (method === 'apply') return trackOperation(mutationOperations, Promise.resolve(handler(session, input)))
    if (method === 'save-key' || method === 'remove-key')
      return trackOperation(storageOperations, Promise.resolve(handler(session, input)))
    return handler(session, input)
  })
}

/** @param {WindowSession} session */
function threadsFor(session) {
  let threads = agentThreads.get(session)
  if (!threads) {
    threads = new AgentThreads()
    agentThreads.set(session, threads)
  }
  return threads
}

handle('agent-threads-list', session => threadsFor(session).list())

handle('agent-threads-memory', async session => {
  const threads = threadsFor(session)
  const { memory, processes } = await sampleAgentMemory()
  const activities = await threads.memoryActivities(processes)
  return { ...memory, activities }
})

handle('agent-threads-children', (session, _event, selection, parentId) => {
  const threads = agentThreads.get(session)
  if (
    !threads ||
    typeof selection !== 'string' ||
    selection.length !== 36 ||
    (parentId !== undefined && typeof parentId !== 'string')
  )
    throw new Error('Choose an available agent thread.')
  return threads.children(selection, parentId)
})

handle('agent-threads-read', (session, _event, id, selection, childId) => {
  const threads = agentThreads.get(session)
  if (
    !threads ||
    typeof id !== 'string' ||
    typeof selection !== 'string' ||
    selection.length !== 36 ||
    (childId !== undefined && typeof childId !== 'string')
  )
    throw new Error('Choose an available agent thread.')
  return threads.read(id, selection, childId)
})

handle(
  'agent-threads-update',
  (session, _event, id, selection, childId) => {
    const threads = agentThreads.get(session)
    if (
      !threads ||
      typeof id !== 'string' ||
      typeof selection !== 'string' ||
      selection.length !== 36 ||
      (childId !== undefined && typeof childId !== 'string')
    )
      throw new Error('Choose an available agent thread.')
    return threads.update(id, selection, childId)
  },
  { minimumSuccessMs: 25 },
)

handle('agent-threads-clear', (session, _event, selection) => {
  if (typeof selection === 'string') agentThreads.get(session)?.clear(selection)
})

handle('agent-threads-file', async (session, event, selection, filename, childId, line) => {
  const threads = agentThreads.get(session)
  if (
    !threads ||
    typeof selection !== 'string' ||
    typeof filename !== 'string' ||
    (childId !== undefined && typeof childId !== 'string') ||
    (line !== undefined && (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1))
  )
    throw new Error('Choose an available agent file link.')
  const { repositoryRoot: root, repositoryScope: scope } = session
  const file = await threads.resolveFile(selection, filename, root && scope ? { root, scope } : undefined, childId)
  if (file.kind === 'workspace') return file
  const repository = await attemptAsync(() => Repository.open(file.path))
  if (!repository.ok)
    throw appError('This linked file could not be opened in Diffpane.', {
      code: 'WORKSPACE_REQUIRED',
    })
  const source = WorkspaceWindow.fromRenderer(event.sender)
  if (!source || source.isDestroyed() || quitPhase !== 'running')
    throw appError('This Diffpane window is no longer available.', { code: 'WINDOW_UNAVAILABLE' })
  openTarget(repository.value.root, source, { initialFile: file.path, initialLine: line })
  return { kind: 'opened' }
})

/** @type {Record<string, (store: IdeaStore, root: string, input: unknown, sender: WorkspaceRenderer) => unknown>} */
const ideaHandlers = {
  list: (store, root) => store.list(root),
  upsert: async (store, root, idea, sender) => {
    const saved = await store.upsert(root, idea)
    broadcastIdeaChange(root, sender, { type: 'upsert', idea: saved })
    return saved
  },
  delete: async (store, root, id, sender) => {
    if (typeof id !== 'string') throw new Error('Invalid idea ID.')
    if (await store.delete(root, id)) broadcastIdeaChange(root, sender, { type: 'delete', id })
  },
}

/** @param {string} root @param {WorkspaceRenderer | null} sender @param {IdeaChange} change */
function broadcastIdeaChange(root, sender, change) {
  for (const session of sessions.values()) {
    if (session.repositoryRoot === root && session.contents !== sender) send(session.contents, 'ideas-change', change)
  }
}

for (const [method, handler] of Object.entries(ideaHandlers)) {
  handle(`ideas-${method}`, (session, event, input) =>
    trackOperation(
      storageOperations,
      session.root().then(root => handler(ideaStore, root, input, event.sender)),
    ),
  )
}

for (const method of ['list', 'change', 'copy']) {
  const updateNotes = async (/** @type {WindowSession} */ session, /** @type {unknown} */ input) => {
    const { root, scope } = await session.reviewWorkspace()
    if (method === 'change') {
      const result = reviewNoteUpdates.then(async () => {
        const notes = await reviewNotes.change(root, scope, input)
        const scopes = new Map([[scope, Promise.resolve(notes)]])
        const recipients = [...sessions.values()].filter(
          other => other.repositoryRoot === root && other.repositoryScope && other.rendererReady,
        )
        const delivered = await Promise.allSettled(
          recipients.map(async other => {
            const otherScope = other.repositoryScope
            if (!otherScope) return
            const pending = scopes.get(otherScope) ?? reviewNotes.list(root, otherScope)
            scopes.set(otherScope, pending)
            const visible = await pending
            send(other.contents, 'review-notes-updated', visible)
          }),
        )
        for (const delivery of delivered) {
          if (delivery.status === 'rejected') logError(delivery.reason, 'broadcast-review-notes')
        }
        return notes
      })
      reviewNoteUpdates = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    }
    await reviewNoteUpdates
    const notes = await reviewNotes.list(root, scope)
    if (method === 'list') return notes
    const { count, text } = formatReviewHandoff(notes)
    if (count) await clipboard.writeText(text)
    return count
  }
  handle(`review-notes-${method}`, (session, _event, input) =>
    trackOperation(storageOperations, updateNotes(session, input)),
  )
}

handle('restart-workspace', session => session.restart())

for (const method of [
  'capture-checkpoint',
  'content-search',
  'content-search-cancel',
  'snapshot',
  'files',
  'files-delta',
  'directory-expanded',
  'document',
  'git-overview',
  'git-changes',
  'git-contents',
  'save',
  'rename',
  'refresh',
  'language-open',
  'language-request',
  'language-cancel',
  'language-close',
  'language-status',
  'howmany-analyze',
  'howmany-file',
  'howmany-close',
]) {
  handle(method, (session, _event, ...args) => {
    const [filename, name] = args
    if (method === 'save' && typeof filename === 'string')
      return changeFiles(session, [filename], () => session.call(method, args))
    if (method === 'rename' && typeof filename === 'string' && typeof name === 'string')
      return changeFiles(session, [filename, path.join(path.dirname(filename), name)], () => session.call(method, args))
    return session.call(method, args)
  })
}
/** @param {WindowSession} session @param {string} filePath @param {'operation-path' | 'operation-destination'} [method] */
async function resolveOperationPath(session, filePath, method = 'operation-path') {
  const absolute = await session.call(method, [filePath])
  if (typeof absolute !== 'string') throw new Error('Invalid workspace path response.')
  return absolute
}

handle('trash', (session, _event, filePath, expectedIdentity) => {
  if (typeof filePath !== 'string' || (expectedIdentity !== undefined && typeof expectedIdentity !== 'string'))
    throw appError('Choose a file or folder inside this project.', { code: 'INVALID_FILE_ACTION' })
  let entries = trashedEntries.get(session)
  if (!entries) {
    entries = new Map()
    trashedEntries.set(session, entries)
  }
  return changeFiles(session, [filePath], async () => {
    const originalPath = await resolveOperationPath(session, filePath)
    const item = await shell.trashItem(originalPath, expectedIdentity)
    let receipt = null
    if (item) {
      const token = randomUUID()
      entries.set(token, { filePath, originalPath, ...item })
      receipt = { token, identity: item.identity }
    }
    await background('refresh-after-trash', () => session.call('refresh'))
    return receipt
  })
})
handle('restore-trash', (session, _event, filePath, token) => {
  if (typeof filePath !== 'string' || typeof token !== 'string')
    throw appError('Choose a file or folder to restore.', { code: 'INVALID_FILE_ACTION' })
  return changeFiles(session, [filePath], async () => {
    const entries = trashedEntries.get(session)
    const item = entries?.get(token)
    if (!entries || !item || item.filePath !== filePath)
      throw appError('This item is no longer available to restore.', { code: 'TRASH_ENTRY_UNAVAILABLE' })
    const destination = await resolveOperationPath(session, filePath, 'operation-destination')
    if (destination !== item.originalPath)
      throw appError('The original location has changed since this item was moved to Trash.', {
        code: 'TRASH_DESTINATION_CHANGED',
      })
    await shell.restoreTrash(item.path, destination, item.identity)
    entries.delete(token)
    await background('refresh-after-restore', () => session.call('refresh'))
  })
})
handle('file-action', async (session, _event, action, filePath) => {
  if (action !== 'reveal' && action !== 'copy-path' && action !== 'copy-relative-path')
    throw appError('Unknown file action.', { code: 'INVALID_FILE_ACTION' })
  if (typeof filePath !== 'string')
    throw appError('Choose a file or folder inside this project.', { code: 'INVALID_FILE_ACTION' })
  const absolute = await resolveOperationPath(session, filePath)
  if (action === 'reveal') await shell.showItemInFolder(absolute)
  else await clipboard.writeText(action === 'copy-path' ? absolute : filePath)
})

onRenderer('saves-flushed', (session, success, id) => {
  if (session.flushing && session.flushing.id === id) session.finishFlush?.(success === true)
})
onRenderer('save-state', (session, dirty) => {
  session.hasPendingSaves = dirty === true
})
onRenderer('renderer-ready', session => {
  const startedAt = rendererNavigationStarts.get(session)
  if (startedAt !== undefined) {
    rendererNavigationStarts.delete(session)
    windowDiagnostics(session.contents.id).measure('renderer-shell-ready', startedAt)
  }
  session.contents.loading = false
  session.rendererReady = true
  session.announceFatal()
  if (session.settingsRequested && send(session.contents, 'open-settings')) session.settingsRequested = false
})
handle('terminal-toggle', session => terminals.get(session)?.toggle() ?? false)
onRenderer('terminal-layout', (session, height, bottom, theme) => {
  terminals.get(session)?.layout(height, bottom, theme)
})
onRenderer('shortcuts-modal', (session, active) => {
  const { contents } = session
  if (active === true) modalWindows.add(contents)
  else modalWindows.delete(contents)
  contents.setIgnoreMenuShortcuts(capturingShortcuts.has(contents))
  const window = WorkspaceWindow.fromRenderer(contents)
  if (window?.isFocused()) syncFileMenu(session)
})
onRenderer('file-menu-actions', (session, actions) => {
  if (!session.rendererReady || !Array.isArray(actions) || actions.length > Object.keys(fileMenuLabels).length) return
  fileMenuActions.set(session, new Set(actions.filter(isFileMenuAction)))
  if (WorkspaceWindow.fromRenderer(session.contents)?.isFocused()) syncFileMenu(session)
})
/** @type {Record<string, (sender: WorkspaceRenderer, ...args: unknown[]) => unknown>} */
const shortcutHandlers = {
  get: refreshShortcuts,
  set: (_sender, action, binding) => updateShortcuts(() => shortcutPreferences.set(action, binding)),
  reset: (_sender, action) => updateShortcuts(() => shortcutPreferences.reset(action)),
  capture: (sender, active) => {
    if (active === true) capturingShortcuts.add(sender)
    else capturingShortcuts.delete(sender)
    sender.setIgnoreMenuShortcuts(active === true)
  },
}
for (const [method, handler] of Object.entries(shortcutHandlers)) {
  handle(`shortcuts-${method}`, (_session, event, ...args) => handler(event.sender, ...args))
}

/** @template T @param {() => Promise<T>} update */
function queuePreferenceUpdate(update) {
  const result = preferenceUpdates.then(update)
  preferenceUpdates = result.then(
    () => undefined,
    () => undefined,
  )
  return trackOperation(storageOperations, result)
}

const uiPreferenceCollection = 'ui-preferences'
/** @param {import('../../persistence/database/local-state.ts').StateRecords} records
 * @param {import('../../persistence/preferences/ui-preferences.ts').UiPreferencePatch} patch */
function writeUiPreference(records, patch) {
  const current = records.get(uiPreferenceCollection, '', patch.key)
  const next = applyUiPreferencePatch(patch, current)
  if (JSON.stringify(current) !== JSON.stringify(next.value))
    records.put(uiPreferenceCollection, '', next.key, next.value)
  return next
}

/** @param {import('../../persistence/preferences/ui-preferences.ts').UiPreferenceUpdate} updated */
function broadcastUiPreference(updated) {
  const event = { ...updated, revision: ++preferenceRevision }
  for (const session of sessions.values()) send(session.contents, 'preferences-updated', event)
  return event
}

/** @param {import('../../persistence/database/local-state.ts').StateRecords} records */
function readUiPreferences(records) {
  /** @type {Partial<import('../../persistence/preferences/ui-preferences.ts').UiPreferences>} */
  const preferences = {}
  for (const key of uiPreferenceKeys) {
    const value = records.get(uiPreferenceCollection, '', key)
    if (value !== undefined) {
      const update = parseUiPreference(key, value)
      Object.assign(preferences, { [update.key]: update.value })
    }
  }
  return preferences
}

handle('preferences-get', (_session, _event, legacy) =>
  queuePreferenceUpdate(async () => {
    const previous = { ...pendingLegacyPreferences, ...parseUiPreferences(legacy) }
    if (!Object.keys(previous).length) return localState.read(readUiPreferences)
    const preferences = await localState.write(records => {
      const stored = readUiPreferences(records)
      for (const key of uiPreferenceKeys) {
        if (stored[key] === undefined && previous[key] !== undefined)
          records.put(uiPreferenceCollection, '', key, previous[key])
      }
      return { ...previous, ...stored }
    })
    pendingLegacyPreferences = {}
    return preferences
  }),
)

handle('preferences-set', (_session, _event, key, input) =>
  queuePreferenceUpdate(async () => {
    const patch = parseUiPreferencePatch(key, input)
    return broadcastUiPreference(await localState.write(records => writeUiPreference(records, patch)))
  }),
)

handle('onboarding-enter', (session, _event, surface, replay) =>
  queuePreferenceUpdate(async () => {
    const state = await localState.write(records => readOnboarding(records, existingProfile))
    const { stage } = state
    const show =
      replay === true ||
      (surface === 'home' && (isSetupStep(stage) || stage === 'home-tour')) ||
      (surface === 'workspace' && (stage === 'home-tour' || stage === 'workspace-tour'))
    if (!show || session.contents.isDestroyed()) return null
    if (
      onboardingOwner &&
      onboardingOwner !== session &&
      !onboardingOwner.contents.isDestroyed() &&
      sessions.get(onboardingOwner.contents.id) === onboardingOwner
    )
      return null
    onboardingOwner = session
    return state
  }),
)

handle('onboarding-save', (session, _event, input, appearance) =>
  queuePreferenceUpdate(async () => {
    if (onboardingOwner !== session) throw new Error('This window is no longer showing onboarding.')
    const state = parseOnboardingState(input)
    const look = parseOnboardingAppearance(appearance)
    const updated = await localState.write(records => {
      writeOnboarding(records, state)
      return Object.keys(look).length ? writeUiPreference(records, { key: 'appearance', value: look }) : undefined
    })
    if (updated) broadcastUiPreference(updated)
  }),
)

onRenderer('onboarding-release', session => {
  runBackground('release-onboarding', () =>
    queuePreferenceUpdate(() => {
      if (onboardingOwner === session) onboardingOwner = undefined
      return Promise.resolve()
    }),
  )
})

for (const kind of /** @type {const} */ (['folder', 'file']))
  handle(`open-${kind}`, (_session, event) => chooseTarget(WorkspaceWindow.fromRenderer(event.sender), kind))
handle('workspaces-list', () => workspaceWindows.list())
handle('workspaces-current', session => workspaceWindows.current(session))
handle('workspaces-pick-folders', async (session, event) =>
  workspaceWindows.approvePickedFolders(
    session,
    await choosePaths(WorkspaceWindow.fromRenderer(event.sender), 'folders'),
  ),
)
handle('workspaces-save', (session, _event, input, options) => workspaceWindows.save(session, input, options))
handle('workspaces-open', (session, _event, id) => workspaceWindows.open(session, id))
handle('workspaces-switch-folder', (session, _event, folder) => workspaceWindows.switchFolder(session, folder))
handle('workspaces-remove', (session, _event, id) => workspaceWindows.remove(session, id))
handle('workspaces-close', session => workspaceWindows.close(session))
onRenderer('workspaces-remember-file', (session, filename) => {
  if (!session.stopping && quitPhase !== 'draining' && quitPhase !== 'quitting')
    workspaceWindows.rememberFile(session, filename)
})
handle('recent-targets', () =>
  trackOperation(
    storageOperations,
    recentUpdates.then(() => recentTargets.list()),
  ),
)
handle('open-recent', (_session, event, target) =>
  trackOperation(
    storageOperations,
    recentUpdates.then(async () => {
      const recent = (await recentTargets.list()).find(entry => entry.path === target)
      if (!recent) return false
      const metadata = await attemptAsync(() => stat(recent.path))
      if (!metadata.ok && !['ENOENT', 'ENOTDIR'].includes(metadata.error.code)) throw metadata.error
      const info = metadata.ok ? metadata.value : null
      if (!info || (recent.kind === 'file' ? !info.isFile() : !info.isDirectory())) {
        await recentTargets.remove(recent.path)
        return false
      }
      if (quitPhase !== 'running') return false
      openTarget(recent.path, WorkspaceWindow.fromRenderer(event.sender))
      return true
    }),
  ),
)
handle('howmany-export', async (session, event) => {
  const analysis = await session.call('howmany-analyze')
  if (typeof analysis !== 'object' || analysis === null || !('report' in analysis) || !analysis.report)
    throw appError('Analyze the workspace before exporting.', { code: 'REPORT_REQUIRED' })
  /** @type {SaveDialogOptions} */
  const options = {
    title: 'Export HowMany report',
    defaultPath: 'howmany-report.json',
    filters: [{ name: 'JSON report', extensions: ['json'] }],
  }
  const window = WorkspaceWindow.fromRenderer(event.sender)
  const result = await dialog.showSaveDialog(window, options)
  if (result.canceled || !result.filePath) return false
  await writeFile(result.filePath, `${JSON.stringify(analysis.report, null, 2)}\n`, 'utf8')
  return true
})

/** @param {WindowSession} [session] */
function syncFileMenu(session) {
  const actions = session?.rendererReady ? fileMenuActions.get(session) : undefined
  const modalOpen = Boolean(session && modalWindows.has(session.contents))
  updateNativeMenu(
    Object.keys(fileMenuLabels)
      .filter(isFileMenuAction)
      .map(id => {
        const available = actions?.has(id) === true
        let visible = true
        if (id === 'showDiff')
          visible = available && !(actions?.has('showWorkingFile') || actions?.has('closeComparison'))
        else if (id === 'showWorkingFile' || id === 'closeComparison' || id === 'undoDelete' || id === 'redoDelete')
          visible = available
        else if (id === 'undoRename') visible = !actions?.has('undoDelete')
        else if (id === 'redoRename') visible = !actions?.has('redoDelete')
        return { id, enabled: available && !modalOpen, visible }
      }),
  )
}

/** @param {FileMenuAction} action @returns {MenuItemOptions} */
function fileMenuItem(action) {
  return {
    id: action,
    label: fileMenuLabels[action],
    enabled: false,
    visible:
      action !== 'showDiff' &&
      action !== 'showWorkingFile' &&
      action !== 'closeComparison' &&
      action !== 'undoDelete' &&
      action !== 'redoDelete',
    click: () => {
      if (quitPhase !== 'running') return
      const window = WorkspaceWindow.getFocusedWindow()
      const session = window && sessions.get(window.renderer.id)
      if (session?.rendererReady && !modalWindows.has(session.contents) && fileMenuActions.get(session)?.has(action))
        send(session.contents, 'file-menu-action', action)
    },
  }
}

function setApplicationMenu() {
  installWorkspaceMenu({
    isMac,
    shortcuts: shortcutOverrides,
    fileMenuItem,
    diagnosticsAvailable: diagnosticDirectory.ok,
    openSettings: () => windowAction('open-settings', openSettings),
    newWindow: () => windowAction('new-window', () => createWindow()),
    openFolder: () => windowAction('open-folder', () => chooseTarget(WorkspaceWindow.getFocusedWindow(), 'folder')),
    openFile: () => windowAction('open-file', () => chooseTarget(WorkspaceWindow.getFocusedWindow(), 'file')),
    openDiagnostics: () =>
      windowAction('open-diagnostics-folder', async () => {
        if (!diagnosticDirectory.ok) return
        await diagnosticLog?.flush()
        const message = await shell.openPath(diagnosticDirectory.value)
        if (message) throw new Error('Diffpane could not open the diagnostics folder.')
      }),
    showOnboarding,
  })
  const window = WorkspaceWindow.getFocusedWindow()
  syncFileMenu(window ? sessions.get(window.renderer.id) : undefined)
}

/** @param {'setup' | 'tour'} experience */
function showOnboarding(experience) {
  if (quitPhase !== 'running') return
  const window = WorkspaceWindow.getFocusedWindow()
  const session = window && sessions.get(window.renderer.id)
  if (session?.rendererReady && !modalWindows.has(session.contents))
    send(session.contents, 'show-onboarding', experience)
}

app.on('window-focused', window => syncFileMenu(sessions.get(window.renderer.id)))

routeRenderer({ invoke: dispatchTerminalInvoke, send: dispatchTerminalSend })

runBackground(
  'start-app',
  async () => {
    if (diagnosticLog) stopDesktopMetrics = startDesktopMetrics(diagnostics)
    setApplicationMenu()
    runBackground('initialize-onboarding', () =>
      queuePreferenceUpdate(() => localState.write(records => readOnboarding(records, existingProfile))),
    )
    runBackground('load-shortcuts', refreshShortcuts)
    runBackground('migrate-local-state', () =>
      trackOperation(
        storageOperations,
        Promise.all([
          background('migrate-ideas', () => ideaStore.initialize()),
          background('migrate-review-notes', () => reviewNotes.initialize()),
          background('migrate-recent-targets', () => recentTargets.initialize()),
        ]),
      ),
    )
    app.on('window-focused', () => {
      if (quitPhase === 'running') runBackground('load-shortcuts', refreshShortcuts)
    })
    const targets = new Set([...pendingOpenPaths.splice(0), ...launchTargets])
    activated = true
    if (targets.size) for (const target of targets) openTarget(target)
    else createWindow()
    app.on('activate', () => {
      if (!WorkspaceWindow.getAllWindows().length) windowAction('new-window', () => createWindow())
    })
  },
  async error => {
    await dialog.showErrorBox('Diffpane could not start', error.message)
    stopDesktopMetrics?.()
    await diagnosticLog?.close()
    app.exit(1)
  },
)
function resumeEditing() {
  for (const session of sessions.values()) send(session.contents, 'resume-editing')
}
app.on('before-quit', event => {
  if (quitPhase === 'quitting') return
  if (
    quitPhase === 'running' &&
    !sessions.size &&
    !shutdowns.size &&
    !storageOperations.size &&
    !mutationOperations.size
  )
    return
  event.preventDefault()
  if (quitPhase !== 'running') return
  quitPhase = 'flushing'
  runBackground(
    'quit-app',
    async () => {
      try {
        const results = await Promise.all([...sessions.values()].map(session => session.flush()))
        if (results.some(success => !success)) {
          resumeEditing()
          return
        }
        quitPhase = 'draining'
        openPicker?.abort()
        await Promise.allSettled(mutationOperations)
        const pending = [...sessions.values()].map(session => session.stop())
        await Promise.allSettled([...pending, ...shutdowns, ...storageOperations])
        quitPhase = 'quitting'
        app.quit()
      } finally {
        if (quitPhase !== 'quitting') quitPhase = 'running'
      }
    },
    resumeEditing,
  )
})
app.on('window-all-closed', () => app.quit())
hostEvent('app.disconnected', async () => {
  if (quitPhase === 'quitting') return
  quitPhase = 'draining'
  openPicker?.abort()
  await Promise.allSettled(mutationOperations)
  await Promise.allSettled([
    ...Array.from(sessions.values(), session => session.stop()),
    ...shutdowns,
    ...storageOperations,
  ])
  stopDesktopMetrics?.()
  const result = attempt(() => localState.close())
  if (!result.ok) logError(result.error, 'close-local-state')
  diagnostics.event('app-host-disconnected', 'warn')
  await diagnosticLog?.close()
})
let diagnosticsDrained = false
let drainingDiagnostics = false
app.on('will-quit', event => {
  if (diagnosticsDrained) return
  if (diagnosticLog) event.preventDefault()
  if (drainingDiagnostics) return
  drainingDiagnostics = true
  quitPhase = 'quitting'
  stopDesktopMetrics?.()
  const result = attempt(() => localState.close())
  if (!result.ok) logError(result.error, 'close-local-state')
  diagnostics.event('app-stop')
  if (!diagnosticLog) return
  const quit = () => {
    diagnosticsDrained = true
    app.quit()
  }
  void diagnosticLog.close().then(quit, () => {
    console.warn('Diffpane could not finish writing its local diagnostic log.')
    quit()
  })
})
