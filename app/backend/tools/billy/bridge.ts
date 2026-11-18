import type { RendererRequest } from '../../../desktop/host/desktop.ts'
import { WorkspaceWindow } from '../../../desktop/host/desktop.ts'
import { dialog } from '../../../desktop/services/shell.ts'
import { readBillyClaims } from '../billy-claims/claims.ts'
import { readBillyContractDiff } from '../billy-contracts/contracts.ts'
import { listLanes, readLaneChecks, readLaneLog } from '../billy-lanes/lanes.ts'
import { createBillyReplayReader } from '../billy-replay/reader.ts'
import { readBillySiblings } from '../billy-siblings/siblings.ts'
import { createBillyContext, isBillyPath, isBillyWorkspace } from './native.ts'
import { billySetupCommand, checkBillySetup } from './setup.ts'

interface BillyWindow {
  root(): Promise<string>
}

type Register = (
  channel: string,
  listener: (session: BillyWindow, event: RendererRequest, ...input: unknown[]) => unknown,
) => void

interface BillySession {
  controller: AbortController
  context: ReturnType<typeof createBillyContext>
  replay: ReturnType<typeof createBillyReplayReader>
  operations: Map<string, Promise<unknown>>
  pickingReplay: boolean
}

const sessions = new WeakMap<BillyWindow, BillySession>()
const roots = new WeakMap<BillyWindow, Promise<string | null>>()

export function resetBillyReview(session: BillyWindow) {
  sessions.get(session)?.controller.abort()
  sessions.delete(session)
  roots.delete(session)
}

function billyRoot(session: BillyWindow) {
  let result = roots.get(session)
  if (!result) {
    result = session.root().then(async root => ((await isBillyWorkspace(root)) ? root : null))
    roots.set(session, result)
    result.catch(() => {
      if (roots.get(session) === result) roots.delete(session)
    })
  }
  return result
}

async function getBillySession(window: BillyWindow, event: RendererRequest) {
  const rootPromise = billyRoot(window)
  const root = await rootPromise
  if (!root || roots.get(window) !== rootPromise || event.sender.isDestroyed())
    throw new Error('Open a Billy workspace to use these review tools.')
  let session = sessions.get(window)
  if (!session) {
    const controller = new AbortController()
    session = {
      controller,
      context: createBillyContext(root, controller.signal),
      replay: createBillyReplayReader(async () => {
        const owner = WorkspaceWindow.fromRenderer(event.sender)
        if (!owner || owner.isDestroyed() || controller.signal.aborted) return null
        const selected = await dialog.showOpenDialog(owner, {
          title: 'Open a Billy Replay run',
          buttonLabel: 'Open Replay run',
          properties: ['openFile'],
          filters: [{ name: 'Replay run', extensions: ['json'] }],
        })
        if (selected.canceled || controller.signal.aborted) return null
        return selected.filePaths[0] ?? null
      }),
      operations: new Map(),
      pickingReplay: false,
    }
    sessions.set(window, session)
  }
  return session
}

function register(registerHandler: Register, id: string, read: (session: BillySession, input: unknown[]) => unknown) {
  registerHandler(`billy-${id}`, async (window, event, ...input) => {
    const session = await getBillySession(window, event)
    if (id === 'pick-replay' && session.pickingReplay) return null
    // Coalesce duplicate reads from snapshots. Different tools can operate independently.
    const key = JSON.stringify([id, input])
    const prior = session.operations.get(key)
    if (prior) return prior
    if (session.operations.size >= 8) throw new Error('Wait for the current Billy review reads to finish.')
    if (id === 'pick-replay') session.pickingReplay = true
    const pending = Promise.resolve().then(() => {
      session.controller.signal.throwIfAborted()
      return read(session, input)
    })
    session.operations.set(key, pending)
    try {
      return await pending
    } finally {
      session.operations.delete(key)
      if (id === 'pick-replay') session.pickingReplay = false
    }
  })
}

function checkedPath(value: unknown) {
  if (!isBillyPath(value)) throw new Error('Choose a file inside the Billy workspace.')
  return value
}

export async function prepareBillySetup(window: BillyWindow, event: RendererRequest, action: unknown) {
  const session = await getBillySession(window, event)
  const command = await billySetupCommand(session.context.root, action)
  session.controller.signal.throwIfAborted()
  return command
}

export function registerBillyReview(handle: Register) {
  handle('billy-available', async session => Boolean(await billyRoot(session)))
  register(handle, 'setup-status', ({ context }) => checkBillySetup(context.root, context.signal))
  register(handle, 'lanes', session => listLanes(session.context))
  register(handle, 'lane-checks', (session, [slug]) => {
    if (typeof slug !== 'string') throw new Error('Choose an agent lane.')
    return readLaneChecks(session.context, slug)
  })
  register(handle, 'lane-log', (session, [slug, check, capture]) => {
    if (typeof slug !== 'string' || typeof check !== 'string' || typeof capture !== 'string')
      throw new Error('Choose a saved check log.')
    return readLaneLog(session.context, slug, check, capture)
  })
  register(handle, 'claims', (session, [filename]) => readBillyClaims(session.context, checkedPath(filename)))
  register(handle, 'siblings', (session, [filename, line]) => {
    if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1)
      throw new Error('Select a source line to compare sibling functions.')
    return readBillySiblings(session.context, checkedPath(filename), line)
  })
  register(handle, 'contract', (session, [input]) => {
    if (!input || typeof input !== 'object' || !('path' in input) || !('changedPaths' in input))
      throw new Error('Choose a changed file or a contract projection.')
    const projectPath = checkedPath(input.path)
    const changed: unknown = input.changedPaths
    if (!Array.isArray(changed) || changed.length > 8000 || !changed.every(isBillyPath))
      throw new Error('The comparison file list is unavailable or too large.')
    return readBillyContractDiff(session.context, { path: projectPath, changedPaths: changed })
  })
  register(handle, 'playbook', (session, [filename]) =>
    session.replay.playbook(session.context.root, checkedPath(filename)),
  )
  register(handle, 'pick-replay', session => session.replay.pickRun())
  register(handle, 'replay-case', (session, [runId, scenario]) => {
    if (typeof runId !== 'string' || runId.length > 128 || typeof scenario !== 'string' || scenario.length > 256)
      throw new Error('Choose a retained Replay run and scenario.')
    return session.replay.readCase(runId, scenario)
  })
}
