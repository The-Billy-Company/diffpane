import { isAbsolute } from 'node:path'
import type { WorkspaceWindow } from '../host/desktop.ts'
import { hostRequest, reportHostError } from '../host/desktop.ts'

interface DialogFilter {
  name: string
  extensions: string[]
}

interface OpenOptions {
  title: string
  buttonLabel?: string
  properties: ('openDirectory' | 'openFile' | 'multiSelections')[]
  filters?: DialogFilter[]
}

export interface SaveDialogOptions {
  title: string
  defaultPath: string
  filters?: DialogFilter[]
}

interface MessageOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  title: string
  message: string
  detail?: string
  buttons?: string[]
  defaultId?: number
  cancelId?: number
}

type DialogOwner = Pick<WorkspaceWindow, 'label' | 'isDestroyed'>

function isNativePath(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0') && isAbsolute(value)
}

export const dialog = {
  async showOpenDialog(owner: DialogOwner | null, options: OpenOptions) {
    if (owner?.isDestroyed()) return { canceled: true, filePaths: [] }
    const result = await hostRequest('dialog.open', owner?.label ?? null, options)
    if (owner?.isDestroyed()) return { canceled: true, filePaths: [] }
    if (
      !result ||
      typeof result !== 'object' ||
      !('canceled' in result) ||
      typeof result.canceled !== 'boolean' ||
      !('filePaths' in result) ||
      !Array.isArray(result.filePaths) ||
      !result.filePaths.every(isNativePath)
    )
      throw new Error('Invalid open dialog response.')
    return { canceled: result.canceled, filePaths: result.canceled ? [] : result.filePaths }
  },
  async showSaveDialog(owner: DialogOwner | null, options: SaveDialogOptions) {
    if (owner?.isDestroyed()) return { canceled: true, filePath: undefined }
    const result = await hostRequest('dialog.save', owner?.label ?? null, options)
    if (owner?.isDestroyed()) return { canceled: true, filePath: undefined }
    if (!result || typeof result !== 'object' || !('canceled' in result) || typeof result.canceled !== 'boolean')
      throw new Error('Invalid save dialog response.')
    if (result.canceled) return { canceled: true, filePath: undefined }
    if (!('filePath' in result) || !isNativePath(result.filePath)) throw new Error('Invalid save dialog response.')
    return { canceled: false, filePath: result.filePath }
  },
  async showMessageBox(owner: Pick<WorkspaceWindow, 'label'> | null, options: MessageOptions) {
    const result = await hostRequest('dialog.message', owner?.label ?? null, options)
    if (!result || typeof result !== 'object' || !('response' in result) || typeof result.response !== 'number')
      throw new Error('Invalid native dialog response.')
    return { response: result.response }
  },
  showErrorBox(title: string, message: string) {
    return dialog.showMessageBox(null, { type: 'error', title, message })
  },
}

export const clipboard = {
  writeText: (text: string) => hostRequest('clipboard.write', text),
}

export const shell = {
  openExternal: (url: string) => hostRequest('shell.open', url),
  openPath: (path: string) => hostRequest('shell.openPath', path),
  showItemInFolder: (path: string) => hostRequest('shell.reveal', path),
  async trashItem(path: string, expectedIdentity?: string) {
    const result = await hostRequest('shell.trash', path, expectedIdentity)
    if (result === null) return null
    if (
      !result ||
      typeof result !== 'object' ||
      !('path' in result) ||
      !isNativePath(result.path) ||
      !('identity' in result) ||
      typeof result.identity !== 'string'
    )
      throw new Error('Invalid Trash response.')
    return { path: result.path, identity: result.identity }
  },
  restoreTrash: (trashedPath: string, destination: string, identity: string) =>
    hostRequest('shell.restoreTrash', trashedPath, destination, identity),
}

export function showError(title: string, message: string) {
  void dialog.showErrorBox(title, message).catch(reportHostError)
}
