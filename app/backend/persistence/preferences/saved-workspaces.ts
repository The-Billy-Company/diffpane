// Copyright (c) 2026 The Billy Company
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { WORKSPACE_NAME_MAX_LENGTH } from '../../../shared/preferences/saved-workspaces.ts'
import type { SavedWorkspace, WorkspaceDraft } from '../../../shared/preferences/saved-workspaces.ts'
import { appError } from '../../../shared/recovery/app-errors.ts'
import type { LocalState, StateRecords } from '../database/local-state.ts'

const collection = 'workspaces'
const workspaceIdPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/

export function workspaceId(value: unknown) {
  if (typeof value !== 'string' || !workspaceIdPattern.test(value)) throw new Error('Invalid workspace ID.')
  return value
}

export function workspaceFolder(value: unknown) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))
    throw new Error('Invalid workspace folder.')
  return path.resolve(value)
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

export function workspaceDraft(input: unknown): WorkspaceDraft {
  if (!isRecord(input)) throw new Error('Invalid workspace.')
  const { id, name, folders, activeFolder } = input
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim().length > WORKSPACE_NAME_MAX_LENGTH ||
    /[\r\n\0]/.test(name)
  )
    throw new Error(`Enter a workspace name of up to ${WORKSPACE_NAME_MAX_LENGTH} characters.`)
  if (!Array.isArray(folders) || !folders.length) throw new Error('Add at least one folder to the workspace.')
  const unique = [...new Set(folders.map(workspaceFolder))]
  const active = workspaceFolder(activeFolder)
  if (!unique.includes(active)) throw new Error('Choose a folder in the workspace.')
  return {
    id: id === undefined ? undefined : workspaceId(id),
    name: name.trim(),
    folders: unique,
    activeFolder: active,
  }
}

function inside(directory: string, filename: string) {
  const relative = path.relative(directory, filename)
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? relative
    : undefined
}

/** Resolve a repository-relative or folder-relative filename within the selected root, following symlinks safely. */
export async function existingWorkspaceFile(
  root: string,
  scope: string,
  input: unknown,
): Promise<{ filename: string; relative: string } | undefined> {
  if (typeof input !== 'string' || !input || input.includes('\0') || path.isAbsolute(input)) return undefined
  const target = path.resolve(root, input)
  if (!inside(scope, target)) return undefined
  try {
    const filename = await realpath(target)
    const relative = inside(scope, filename)
    if (relative && (await stat(filename)).isFile()) return { filename, relative }
  } catch {
    // The remembered file may have disappeared or become unreadable.
  }
  return undefined
}

interface StoredWorkspace {
  workspace: SavedWorkspace
  files: Record<string, string>
}

function readStoredWorkspace(input: unknown): StoredWorkspace {
  if (!isRecord(input) || !isRecord(input.workspace) || !isRecord(input.files))
    throw new Error('The saved workspace is invalid.')
  const draft = workspaceDraft(input.workspace)
  const { updatedAt } = input.workspace
  if (!draft.id || typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 1)
    throw new Error('The saved workspace is invalid.')

  const files: Record<string, string> = {}
  for (const folder of draft.folders) {
    const filename = input.files[folder]
    if (typeof filename === 'string') files[folder] = filename
  }
  return { workspace: { ...draft, id: draft.id, updatedAt }, files }
}

function getWorkspaceRecord(records: StateRecords, id: string) {
  const input = records.get(collection, '', id)
  return input === undefined ? undefined : readStoredWorkspace(input)
}

export class SavedWorkspaces {
  readonly #state: LocalState

  constructor(state: LocalState) {
    this.#state = state
  }

  list() {
    return this.#state.read(records =>
      records
        .list(collection, '')
        .map(readStoredWorkspace)
        .map(({ workspace }) => workspace)
        .toSorted((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name)),
    )
  }

  get(id: string) {
    return this.#state.read(records => getWorkspaceRecord(records, id)?.workspace)
  }

  save(draft: WorkspaceDraft, expectedUpdatedAt?: number) {
    const id = draft.id ?? randomUUID()
    return this.#state.write(records => {
      const previous = getWorkspaceRecord(records, id)
      if (draft.id && !previous) throw new Error('This saved workspace is no longer available.')
      if (expectedUpdatedAt !== undefined && previous?.workspace.updatedAt !== expectedUpdatedAt) {
        throw appError('This workspace changed in another window. Try again after it refreshes.', {
          code: 'WORKSPACE_CHANGED',
        })
      }
      const workspace: SavedWorkspace = {
        ...draft,
        id,
        updatedAt: Math.max(Date.now(), (previous?.workspace.updatedAt ?? 0) + 1),
      }
      const files = Object.fromEntries(
        Object.entries(previous?.files ?? {}).filter(([folder]) => workspace.folders.includes(folder)),
      )
      records.put(collection, '', id, { workspace, files } satisfies StoredWorkspace)
      return workspace
    })
  }

  opened(id: string, folder: string | null) {
    return this.#state.write(records => {
      const record = getWorkspaceRecord(records, id)
      if (!record) throw new Error('This saved workspace is no longer available.')
      if (folder && !record.workspace.folders.includes(folder))
        throw new Error('This folder was removed from the workspace.')
      record.workspace.activeFolder = folder ?? record.workspace.activeFolder
      record.workspace.updatedAt = Math.max(Date.now(), record.workspace.updatedAt + 1)
      records.put(collection, '', id, record)
      return record.workspace
    })
  }

  file(id: string, folder: string) {
    return this.#state.read(records => getWorkspaceRecord(records, id)?.files[folder])
  }

  rememberFile(id: string, folder: string, filename: string | null) {
    return this.#state.write(records => {
      const record = getWorkspaceRecord(records, id)
      if (!record?.workspace.folders.includes(folder)) return
      if ((record.files[folder] ?? null) === filename) return
      if (filename === null) delete record.files[folder]
      else record.files[folder] = filename
      records.put(collection, '', id, record)
    })
  }

  remove(id: string) {
    return this.#state.write(records => records.delete(collection, '', id))
  }
}
