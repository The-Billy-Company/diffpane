import type { MenuItemOptions } from '../../../desktop/services/menu.ts'
import { setNativeMenu } from '../../../desktop/services/menu.ts'
import type { FileMenuAction } from '../../../shared/preferences/file-menu.ts'
import type { ShortcutAction, ShortcutOverrides } from '../../../shared/preferences/shortcuts.ts'
import { actualSizeBinding, effectiveBinding, nativeAccelerator } from '../../../shared/preferences/shortcuts.ts'

interface WorkspaceMenuOptions {
  isMac: boolean
  shortcuts: ShortcutOverrides
  fileMenuItem: (action: FileMenuAction) => MenuItemOptions
  diagnosticsAvailable: boolean
  openSettings: () => void
  newWindow: () => void
  openFolder: () => void
  openFile: () => void
  openDiagnostics: () => void
  showOnboarding: (experience: 'setup' | 'tour') => void
}

export function installWorkspaceMenu(options: WorkspaceMenuOptions) {
  const { isMac, shortcuts, fileMenuItem } = options
  const accelerator = (action: ShortcutAction) =>
    nativeAccelerator(effectiveBinding(action, shortcuts), isMac) ?? undefined
  setNativeMenu([
    {
      label: 'Diffpane',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: accelerator('openSettings'),
          click: options.openSettings,
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: accelerator('newWindow'),
          click: options.newWindow,
        },
        {
          label: 'Open Folder…',
          accelerator: accelerator('openFolder'),
          click: options.openFolder,
        },
        {
          label: 'Open File…',
          accelerator: accelerator('openFile'),
          click: options.openFile,
        },
        fileMenuItem('searchFiles'),
        { type: 'separator' },
        fileMenuItem('saveFile'),
        fileMenuItem('findInFile'),
        fileMenuItem('showDiff'),
        fileMenuItem('showWorkingFile'),
        fileMenuItem('closeComparison'),
        { type: 'separator' },
        fileMenuItem('revealActiveFile'),
        fileMenuItem('copyRelativePath'),
        { type: 'separator' },
        fileMenuItem('previousEditor'),
        fileMenuItem('closeOtherEditors'),
        fileMenuItem('closeAllEditors'),
        { type: 'separator' },
        { role: 'close', label: 'Close Window', accelerator: accelerator('closeWindow') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom', accelerator: nativeAccelerator(actualSizeBinding(isMac), isMac) ?? undefined },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        {
          label: 'Open Diagnostics Folder',
          enabled: options.diagnosticsAvailable,
          click: options.openDiagnostics,
        },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
    {
      role: 'help',
      submenu: [
        { label: 'Show Setup…', click: () => options.showOnboarding('setup') },
        { label: 'Take a Tour', click: () => options.showOnboarding('tour') },
      ],
    },
  ])
}
