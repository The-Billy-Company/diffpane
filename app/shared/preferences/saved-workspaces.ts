// Copyright (c) 2026 The Billy Company
export const WORKSPACE_NAME_MAX_LENGTH = 100

export function workspaceFolderLabel(folder: string) {
  const separator = /^[a-z]:|^\\\\/i.test(folder) ? /[\\/]/ : '/'
  return folder.split(separator).findLast(Boolean) ?? folder
}

export interface WorkspaceDraft {
  id?: string
  name: string
  folders: string[]
  activeFolder: string
}

export interface SavedWorkspace extends WorkspaceDraft {
  id: string
  updatedAt: number
}

export interface WorkspaceContext {
  workspace: SavedWorkspace
  /** The folder open in this window, independent of the most recent window to use the workspace. */
  folder: string | null
  unavailableFolders: string[]
}

export interface WorkspaceSaveOptions {
  open?: boolean
  expectedUpdatedAt?: number
}
