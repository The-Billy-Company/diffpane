import type { WorkspaceWindow } from '../../../desktop/host/desktop.ts'
import { dialog } from '../../../desktop/services/shell.ts'
import { appError } from '../../../shared/recovery/app-errors.ts'

export type OpenKind = 'file' | 'folder'
export type OpenPickerKind = OpenKind | 'folders'

export function openPickerOptions(kind: OpenPickerKind) {
  const properties: ('openDirectory' | 'openFile' | 'multiSelections')[] = [
    kind === 'file' ? 'openFile' : 'openDirectory',
  ]
  if (kind === 'folders') properties.push('multiSelections')
  return {
    properties,
    title: kind === 'folders' ? 'Choose workspace folders' : kind === 'file' ? 'Open a file' : 'Open a folder',
    buttonLabel: kind === 'folders' ? 'Add Folders' : undefined,
  }
}

export async function pickNativePaths(
  owner: Pick<WorkspaceWindow, 'label' | 'isDestroyed'> | null,
  kind: OpenPickerKind,
  signal: AbortSignal,
): Promise<string[]> {
  if (signal.aborted || owner?.isDestroyed()) return []
  const canceled = Promise.withResolvers<undefined>()
  const abort = () => canceled.resolve(undefined)
  signal.addEventListener('abort', abort, { once: true })
  try {
    const picker = dialog.showOpenDialog(owner, openPickerOptions(kind))
    const selection = await Promise.race([picker, canceled.promise])
    return signal.aborted || owner?.isDestroyed() || !selection || selection.canceled ? [] : selection.filePaths
  } catch {
    if (signal.aborted || owner?.isDestroyed()) return []
    throw appError('The native picker could not open. Try again.', {
      code: 'PICKER_UNAVAILABLE',
      operation: `open-${kind}`,
    })
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
