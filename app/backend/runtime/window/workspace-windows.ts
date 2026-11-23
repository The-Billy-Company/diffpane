// Copyright (c) 2026 The Billy Company
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { SavedWorkspace, WorkspaceContext, WorkspaceDraft } from '../../../shared/preferences/saved-workspaces.ts'
import { appError } from '../../../shared/recovery/app-errors.ts'
import {
  existingWorkspaceFile,
  workspaceDraft,
  workspaceFolder,
  workspaceId,
} from '../../persistence/preferences/saved-workspaces.ts'
import type { SavedWorkspaces } from '../../persistence/preferences/saved-workspaces.ts'
import { Repository } from '../../workspace/repository/repository.mjs'

export interface WorkspaceNavigation {
  directory: string | null
  workspace?: WorkspaceContext
  rememberedFile?: string
}

interface WorkspaceWindow {
  workspace?: WorkspaceContext
  directory: string | null
  repositoryRoot?: string
  repositoryScope?: string
  flush(): Promise<boolean>
  canNavigate(): boolean
  navigate(target: WorkspaceNavigation): void
  resume(): void
}

interface WorkspaceWindowOptions {
  changed: () => void
  track: <T>(pending: Promise<T>) => Promise<T>
  log: (error: unknown) => void
}

interface FileSelection {
  id: string
  folder: string
  root: string
  scope: string
  filename: string | null
  timer: ReturnType<typeof setTimeout>
  resolve: VoidFunction
}

interface FileMemory {
  selection?: FileSelection
  writes: Promise<void>
}

async function openableFolder(folder: string) {
  const name = path.basename(folder) || folder
  let directory: boolean
  try {
    directory = (await stat(folder)).isDirectory()
  } catch (error) {
    if (error instanceof Error && 'code' in error && ['EACCES', 'EPERM'].includes(String(error.code))) {
      throw appError(`Diffpane doesn’t have permission to open “${name}”.`, { code: 'WORKSPACE_FOLDER_ACCESS' })
    }
    directory = false
  }
  if (!directory) throw appError(`“${name}” is no longer available.`, { code: 'WORKSPACE_FOLDER_UNAVAILABLE' })
  try {
    return (await Repository.open(folder)).scope
  } catch {
    throw appError(`“${name}” could not be opened.`, {
      code: 'WORKSPACE_FOLDER_UNAVAILABLE',
    })
  }
}

async function missingFolders(folders: string[]) {
  const present = await Promise.all(folders.map(async folder => (await stat(folder).catch(() => null))?.isDirectory()))
  return folders.filter((_, index) => !present[index])
}

async function planWorkspace(draft: WorkspaceDraft, preferredFolder = draft.activeFolder, alternate = true) {
  const unavailable = new Set(await missingFolders(draft.folders))
  const candidates = alternate
    ? [preferredFolder, ...draft.folders.filter(folder => folder !== preferredFolder)]
    : [preferredFolder]
  for (const folder of candidates) {
    if (alternate && unavailable.has(folder)) continue
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Only probe another folder when this one fails.
      const scope = await openableFolder(folder)
      return { folder, scope, unavailableFolders: [...unavailable] }
    } catch (error) {
      if (!alternate) throw error
      unavailable.add(folder)
    }
  }
  return { folder: null, scope: null, unavailableFolders: [...unavailable] }
}

export class WorkspaceWindows {
  readonly #workspaces: SavedWorkspaces
  readonly #options: WorkspaceWindowOptions
  readonly #requests = new WeakSet<WorkspaceWindow>()
  readonly #fileMemory = new WeakMap<WorkspaceWindow, FileMemory>()
  readonly #standaloneFiles = new WeakMap<WorkspaceWindow, string>()
  readonly #picked = new WeakMap<WorkspaceWindow, Set<string>>()

  constructor(workspaces: SavedWorkspaces, options: WorkspaceWindowOptions) {
    this.#workspaces = workspaces
    this.#options = options
  }

  list() {
    return this.#options.track(this.#workspaces.list())
  }

  async current(window: WorkspaceWindow) {
    const current = window.workspace
    if (!current) return null
    const workspace = await this.#options.track(this.#workspaces.get(current.workspace.id))
    if (current !== window.workspace) return window.workspace ?? null
    if (!workspace || (current.folder && !workspace.folders.includes(current.folder))) {
      window.workspace = undefined
      return null
    }
    const missing = new Set(await missingFolders(workspace.folders))
    const returned = current.unavailableFolders.filter(
      folder => workspace.folders.includes(folder) && !missing.has(folder),
    )
    const probes = await Promise.allSettled(returned.map(openableFolder))
    for (const [index, folder] of returned.entries()) {
      if (probes[index]?.status === 'rejected') missing.add(folder)
    }
    const unavailableFolders = workspace.folders.filter(folder => missing.has(folder))
    const next = { workspace, folder: current.folder, unavailableFolders }
    if (current === window.workspace) window.workspace = next
    return window.workspace ?? null
  }

  async approvePickedFolders(window: WorkspaceWindow, paths: string[]) {
    const folders = [...new Set(await Promise.all(paths.map(folder => openableFolder(workspaceFolder(folder)))))]
    const picked = this.#picked.get(window) ?? new Set()
    for (const folder of folders) picked.add(folder)
    this.#picked.set(window, picked)
    return folders
  }

  async save(window: WorkspaceWindow, input: unknown, options: unknown) {
    const draft = workspaceDraft(input)
    if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options)))
      throw new Error('Invalid workspace save options.')
    const open = options && 'open' in options ? options.open : undefined
    const expectedUpdatedAt = options && 'expectedUpdatedAt' in options ? options.expectedUpdatedAt : undefined
    if (open !== undefined && typeof open !== 'boolean') throw new Error('Invalid workspace save options.')
    if (
      expectedUpdatedAt !== undefined &&
      (typeof expectedUpdatedAt !== 'number' || !Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 1)
    )
      throw new Error('Invalid saved workspace timestamp.')
    const previous = draft.id ? await this.#options.track(this.#workspaces.get(draft.id)) : undefined
    const known = new Set(previous?.folders)
    const picked = this.#picked.get(window)
    const added = draft.folders.filter(folder => !known.has(folder))
    for (const folder of added) {
      if (!picked?.has(folder) && folder !== window.repositoryScope && folder !== window.directory)
        throw new Error('Choose folders with the workspace folder picker.')
    }
    await Promise.all(added.map(openableFolder))
    const activeRemoved =
      draft.id &&
      draft.id === window.workspace?.workspace.id &&
      window.workspace.folder &&
      !draft.folders.includes(window.workspace.folder)
    if (!(open || activeRemoved)) {
      const workspace = await this.#options.track(this.#workspaces.save(draft, expectedUpdatedAt))
      this.#options.changed()
      return workspace
    }
    const plan = await planWorkspace(draft)
    return this.#withNavigation(window, async () => {
      // An old active-folder selection can be unavailable. Keep it in the saved
      // list and resume in another folder where possible.
      const workspace = await this.#workspaces.save(
        { ...draft, activeFolder: plan.folder ?? draft.activeFolder },
        expectedUpdatedAt,
      )
      const fromStandalone =
        !window.workspace && plan.scope && window.repositoryRoot && window.repositoryScope === plan.scope
          ? await existingWorkspaceFile(window.repositoryRoot, plan.scope, this.#standaloneFiles.get(window))
          : undefined
      const launch = await this.#launch(workspace, plan, fromStandalone?.relative)
      window.navigate(launch)
      this.#options.changed()
      return workspace
    })
  }

  async open(window: WorkspaceWindow, input: unknown) {
    const id = workspaceId(input)
    const workspace = await this.#options.track(this.#workspaces.get(id))
    if (!workspace) throw new Error('This saved workspace is no longer available.')
    const plan = await planWorkspace(workspace)
    return this.#withNavigation(window, async () => {
      const updated = await this.#workspaces.opened(id, plan.folder)
      window.navigate(await this.#launch(updated, plan))
      this.#options.changed()
      return true
    })
  }

  async switchFolder(window: WorkspaceWindow, input: unknown) {
    const current = await this.current(window)
    const folder = workspaceFolder(input)
    if (!current?.workspace.folders.includes(folder)) throw new Error('Choose an available folder in this workspace.')
    if (current.folder === folder) return true
    const plan = await planWorkspace(current.workspace, folder, false)
    return this.#withNavigation(window, async () => {
      const updated = await this.#workspaces.opened(current.workspace.id, folder)
      window.navigate(await this.#launch(updated, plan))
      this.#options.changed()
      return true
    })
  }

  async close(window: WorkspaceWindow) {
    if (!window.workspace && !window.directory) return false
    return this.#withNavigation(window, () => {
      window.navigate({ directory: null })
      return true
    })
  }

  async remove(window: WorkspaceWindow, input: unknown) {
    const id = workspaceId(input)
    const remove = async () => {
      const deleted = await this.#workspaces.remove(id)
      if (window.workspace?.workspace.id === id) window.navigate({ directory: null })
      if (deleted) this.#options.changed()
      return deleted
    }
    if (window.workspace?.workspace.id === id) return this.#withNavigation(window, remove)
    return this.#options.track(remove())
  }

  async #withNavigation<T>(window: WorkspaceWindow, action: () => T | Promise<T>) {
    if (this.#requests.has(window) || !window.canNavigate())
      throw appError('This window is already changing workspaces.', { code: 'WORKSPACE_NAVIGATION_PENDING' })
    this.#requests.add(window)
    let started = false
    try {
      if (!(await window.flush()))
        throw appError('Save the current edits before changing workspaces.', { code: 'SAVE_FLUSH_FAILED' })
      await this.#flushFile(window)
      if (!window.canNavigate()) throw appError('This window is no longer available.', { code: 'WINDOW_UNAVAILABLE' })
      const result = await this.#options.track(Promise.resolve(action()))
      started = true
      return result
    } finally {
      this.#requests.delete(window)
      if (!started) window.resume()
    }
  }

  async #launch(workspace: SavedWorkspace, plan: Awaited<ReturnType<typeof planWorkspace>>, initialPath?: string) {
    const { folder, scope, unavailableFolders } = plan
    let rememberedFile
    if (folder && scope) {
      const stored = initialPath ?? (await this.#workspaces.file(workspace.id, folder).catch(this.#options.log))
      rememberedFile = (await existingWorkspaceFile(scope, scope, stored))?.filename
    }
    return { directory: folder, workspace: { workspace, folder, unavailableFolders }, rememberedFile }
  }

  rememberFile(window: WorkspaceWindow, filename: unknown) {
    const context = window.workspace
    const { repositoryRoot: root, repositoryScope: scope } = window
    if (!root || !scope || (filename !== null && typeof filename !== 'string')) return
    if (!context) {
      if (filename === null) this.#standaloneFiles.delete(window)
      else this.#standaloneFiles.set(window, filename)
      return
    }
    if (!context.folder) return
    const memory = this.#fileMemory.get(window) ?? { writes: Promise.resolve() }
    this.#fileMemory.set(window, memory)
    const pending = memory.selection
    clearTimeout(pending?.timer)
    const timer = setTimeout(() => void this.#flushFile(window), 180)
    if (pending) {
      pending.filename = filename
      pending.timer = timer
    } else {
      const { promise, resolve } = Promise.withResolvers<void>()
      memory.selection = { id: context.workspace.id, folder: context.folder, root, scope, filename, timer, resolve }
      void this.#options.track(promise).catch(this.#options.log)
    }
  }

  #flushFile(window: WorkspaceWindow) {
    const memory = this.#fileMemory.get(window)
    const pending = memory?.selection
    if (!memory || !pending) return memory?.writes
    clearTimeout(pending.timer)
    memory.selection = undefined
    memory.writes = memory.writes
      .then(async () => {
        const { id, folder, root, scope, filename } = pending
        if (filename === null) return this.#workspaces.rememberFile(id, folder, null)
        const file = await existingWorkspaceFile(root, scope, filename)
        return file ? this.#workspaces.rememberFile(id, folder, file.relative) : undefined
      })
      .catch(this.#options.log)
      .finally(pending.resolve)
    return memory.writes
  }
}
