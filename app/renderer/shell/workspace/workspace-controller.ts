import type { DiffpaneApi } from '../../../electron/runtime/window/preload.ts'
import type { WorkspaceContext, WorkspaceDraft } from '../../../shared/preferences/saved-workspaces.ts'
import { appError } from '../../../shared/recovery/app-errors.ts'
import { showWorkspaceSetup } from './workspace-setup.ts'

interface Options {
  api: DiffpaneApi['workspaces']
  standaloneFolder: () => string | null
  isBlocked: () => boolean
  setOpening: (opening: boolean) => void
  render: (context: WorkspaceContext | null, busy: boolean) => void
}

function requireNavigation(accepted: boolean, message: string) {
  if (!accepted) throw appError(message, { code: 'WORKSPACE_NAVIGATION_UNAVAILABLE' })
}

export function createWorkspaceController({ api, standaloneFolder, isBlocked, setOpening, render }: Options) {
  let context: WorkspaceContext | null = null
  let busy = false
  let disposed = false
  let refreshVersion = 0
  let remembered: string | undefined

  function update() {
    if (!disposed) render(context, busy)
  }

  async function refresh() {
    const version = ++refreshVersion
    const next = await api.current()
    if (!disposed && version === refreshVersion) {
      context = next
      update()
    }
  }

  async function perform(action: () => Promise<void>) {
    if (busy || disposed || isBlocked()) return
    const previousFocus = document.activeElement
    busy = true
    setOpening(true)
    update()
    try {
      await action()
    } finally {
      busy = false
      if (!disposed) setOpening(false)
      update()
      if (!disposed && !isBlocked() && document.activeElement === document.body && previousFocus instanceof HTMLElement)
        previousFocus.focus({ preventScroll: true })
    }
  }

  async function save(draft: WorkspaceDraft, open = false, expectedUpdatedAt?: number) {
    await api.save(draft, { open, expectedUpdatedAt })
    if (!open) await refresh()
  }

  return {
    get context() {
      return context
    },
    update,
    refresh,
    create: () =>
      perform(async () => {
        const currentFolder = standaloneFolder()
        const folders = currentFolder ? [currentFolder] : await api.pickFolders()
        if (!folders.length || disposed) return
        await showWorkspaceSetup({
          folders,
          pick: () => api.pickFolders(),
          save: async (name, members) => {
            const activeFolder = members[0]
            if (!activeFolder) return
            await save({ name, folders: members, activeFolder }, true)
          },
        })
      }),
    open: (id: string) =>
      perform(async () => {
        requireNavigation(await api.open(id), 'This workspace couldn’t be opened. It may have been deleted.')
      }),
    select: (path: string) =>
      perform(async () => {
        if (path !== context?.folder) {
          requireNavigation(await api.switchFolder(path), 'Couldn’t open this folder. Check that it is available.')
        }
      }),
    add: () =>
      perform(async () => {
        const picked = await api.pickFolders()
        if (!picked.length || disposed) return
        await refresh()
        if (!context) return
        const { workspace, folder } = context
        const folders = [...new Set([...workspace.folders, ...picked])]
        const activeFolder = folder === null ? picked[0] : workspace.activeFolder
        if (activeFolder && (folders.length !== workspace.folders.length || folder === null))
          await save(
            { id: workspace.id, name: workspace.name, folders, activeFolder },
            folder === null,
            workspace.updatedAt,
          )
      }),
    remove: (path: string) =>
      perform(async () => {
        const { workspace, folder, unavailableFolders } = context ?? {}
        if (!workspace) return
        const folders = workspace.folders.filter(member => member !== path)
        if (folders.length === workspace.folders.length) return
        const activeFolder = folders.includes(workspace.activeFolder)
          ? workspace.activeFolder
          : (folders.find(member => !unavailableFolders?.includes(member)) ?? folders[0])
        if (activeFolder)
          await save(
            { id: workspace.id, name: workspace.name, folders, activeFolder },
            folder === path,
            workspace.updatedAt,
          )
      }),
    rename: (name: string) =>
      perform(async () => {
        const workspace = context?.workspace
        if (workspace && workspace.name !== name.trim()) {
          const { id, folders, activeFolder, updatedAt } = workspace
          await save({ id, name, folders, activeFolder }, false, updatedAt)
        }
      }),
    delete: () =>
      perform(async () => {
        if (context) requireNavigation(await api.remove(context.workspace.id), 'Couldn’t delete this workspace.')
      }),
    close: () =>
      perform(async () => {
        requireNavigation(await api.close(), 'Couldn’t return to Home. Try again after your changes are saved.')
      }),
    rememberFile(path: string) {
      if (disposed || path === remembered) return
      remembered = path
      api.rememberFile(path)
    },
    dispose() {
      disposed = true
    },
  }
}
