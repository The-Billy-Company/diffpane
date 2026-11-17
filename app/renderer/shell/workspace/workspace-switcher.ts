import { WORKSPACE_NAME_MAX_LENGTH, workspaceFolderLabel } from '../../../shared/preferences/saved-workspaces.ts'
import { runTask } from '../recovery/errors.ts'
import { requireElement } from './dom.js'
import { workspaceGlyph } from './workspace-glyph.ts'
import './workspace-switcher.css'

interface WorkspaceSwitcherState {
  workspace: { id: string; name: string; folders: readonly string[] } | null
  rootPath: string | null
  projectName: string
  unavailableFolders?: readonly string[]
  busy?: boolean
}

type Action = () => void | Promise<void>

interface WorkspaceSwitcherActions {
  onCreate: Action
  onSelect: (path: string) => ReturnType<Action>
  onAdd: Action
  onRemove: (path: string) => ReturnType<Action>
  onRename: (name: string) => ReturnType<Action>
  onClose: Action
  onDelete: Action
}

const icon = {
  chevron: strokeIcon('<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>'),
  folder: strokeIcon('<path d="M2 4.5a1 1 0 0 1 1-1h3.1L7.6 5H13a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"/>'),
  check: strokeIcon('<path d="m3.5 8.5 3 3 6-6"/>'),
  plus: strokeIcon('<path d="M8 3.5v9m-4.5-4.5h9"/>'),
  pencil: strokeIcon('<path d="m10.5 3 2.5 2.5m-9.5 4.5L10.5 3a1.8 1.8 0 0 1 2.5 2.5l-7 7-3.3.8z"/>'),
  home: strokeIcon('<path d="m2.5 7 5.5-4.5L13.5 7v5.5h-4V9h-3v3.5h-4z"/>'),
  remove: strokeIcon('<path d="m5 5 6 6M11 5l-6 6"/>'),
  trash: strokeIcon('<path d="M2.5 4.5h11m-7.5 0V2.8h4v1.7m2.5 0-.7 8.4H4.2l-.7-8.4M6.5 7v3.5m3-3.5v3.5"/>'),
}

function strokeIcon(path: string): string {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
}

function button(label: string, className: string, glyph = ''): HTMLButtonElement {
  const control = document.createElement('button')
  control.type = 'button'
  control.className = className
  if (glyph) control.innerHTML = glyph
  if (label) control.append(label)
  return control
}

export function createWorkspaceSwitcher(host: HTMLElement | null, actions: WorkspaceSwitcherActions) {
  if (!host) throw new Error('Missing workspace switcher host.')
  const project = requireElement(host, '#project-name', HTMLElement)
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'workspace-switcher-toggle'
  trigger.hidden = true
  trigger.innerHTML = `
    <span class="workspace-switcher-identity">
      <span class="workspace-switcher-glyph">${workspaceGlyph}</span><span class="workspace-switcher-name"></span>
    </span>
    <span class="workspace-switcher-root"></span>
    <span class="workspace-switcher-chevron">${icon.chevron}</span>
  `
  const triggerName = requireElement(trigger, '.workspace-switcher-name', HTMLElement)
  const triggerRoot = requireElement(trigger, '.workspace-switcher-root', HTMLElement)

  const panel = document.createElement('div')
  panel.id = 'workspace-switcher'
  panel.className = 'workspace-switcher-panel'
  panel.setAttribute('popover', 'auto')
  panel.setAttribute('role', 'group')
  trigger.popoverTargetElement = panel
  trigger.setAttribute('aria-controls', panel.id)
  trigger.setAttribute('aria-expanded', 'false')
  host.append(trigger, panel)

  let state: WorkspaceSwitcherState = { workspace: null, rootPath: null, projectName: '' }
  let signature = ''
  let editing = false

  function perform(label: string, action: Action) {
    const restoreFocus = panel.contains(document.activeElement)
    panel.hidePopover()
    if (restoreFocus && document.activeElement === document.body) trigger.focus({ preventScroll: true })
    runTask(label, action)
  }

  function actionButton(label: string, glyph: string, action: Action, close = true): HTMLButtonElement {
    const control = button(label, 'workspace-switcher-action', glyph)
    control.addEventListener('click', () => {
      if (close) perform(label, action)
      else runTask(label, action)
    })
    return control
  }

  function renderFolders(folders: readonly string[]): HTMLElement {
    const list = document.createElement('ul')
    list.className = 'workspace-switcher-folders'
    list.setAttribute('aria-label', 'Workspace folders')
    const unavailable = new Set(state.unavailableFolders)
    const canReplaceRoot = folders.some(path => path !== state.rootPath && !unavailable.has(path))
    for (const path of folders) {
      const name = workspaceFolderLabel(path)
      const active = path === state.rootPath
      const missing = unavailable.has(path)
      const row = document.createElement('li')
      row.className = 'workspace-switcher-folder'
      if (active) row.dataset.active = ''
      const open = button('', 'workspace-switcher-open', icon.folder)
      open.title = path
      open.disabled = missing
      if (active) open.setAttribute('aria-current', 'true')
      const identity = document.createElement('span')
      identity.className = 'workspace-switcher-folder-copy'
      const label = document.createElement('span')
      label.className = 'workspace-switcher-folder-name'
      label.textContent = name
      const location = document.createElement('span')
      location.className = 'workspace-switcher-folder-path'
      location.textContent = path
      identity.append(label, location)
      open.append(identity)
      if (active || missing) {
        const status = document.createElement('span')
        status.className = 'workspace-switcher-folder-status'
        if (missing) status.textContent = 'Unavailable'
        else status.innerHTML = icon.check
        open.append(status)
      }
      open.addEventListener('click', () => {
        if (active) panel.hidePopover()
        else perform('Open workspace folder', () => actions.onSelect(path))
      })

      const remove = button('', 'workspace-switcher-remove', icon.remove)
      remove.setAttribute('aria-label', `Remove ${name} from workspace · ${path}`)
      remove.disabled = folders.length < 2 || (active && !canReplaceRoot)
      remove.title = 'Remove from workspace'
      remove.addEventListener('click', () => perform('Remove workspace folder', () => actions.onRemove(path)))
      row.append(open, remove)
      list.append(row)
    }
    return list
  }

  function renderMenu() {
    editing = false
    const { workspace } = state
    panel.dataset.kind = workspace ? 'workspace' : 'standalone'
    panel.setAttribute('aria-label', workspace ? `${workspace.name} workspace` : 'Folder actions')
    const commands = document.createElement('div')
    commands.className = 'workspace-switcher-actions'
    const home = actionButton('Go to Home', icon.home, actions.onClose)
    if (!workspace) {
      commands.append(actionButton('Create Workspace from Folder…', workspaceGlyph, actions.onCreate), home)
      panel.replaceChildren(commands)
      return
    }

    const header = document.createElement('div')
    header.className = 'workspace-switcher-header'
    header.innerHTML = `
      <span class="workspace-switcher-header-glyph">${workspaceGlyph}</span>
      <div class="workspace-switcher-header-copy">
        <div class="workspace-switcher-header-name"></div>
        <div class="workspace-switcher-header-count"></div>
      </div>
    `
    requireElement(header, '.workspace-switcher-header-name', HTMLElement).textContent = workspace.name
    requireElement(header, '.workspace-switcher-header-count', HTMLElement).textContent =
      `${workspace.folders.length} ${workspace.folders.length === 1 ? 'folder' : 'folders'}`

    const rename = actionButton('Rename Workspace…', icon.pencil, () => renameWorkspace(workspace.name), false)
    rename.dataset.edit = 'rename'
    const remove = actionButton('Delete Workspace…', icon.trash, () => deleteWorkspace(workspace.name), false)
    remove.dataset.edit = 'delete'
    commands.append(actionButton('Add Folders…', icon.plus, actions.onAdd), rename, home, remove)
    panel.replaceChildren(header, renderFolders(workspace.folders), commands)
  }

  function editWorkspace(kind: 'rename' | 'delete', title: string) {
    editing = true
    const form = document.createElement('form')
    form.className = 'workspace-switcher-edit'
    const heading = document.createElement('h2')
    heading.id = 'workspace-switcher-edit-title'
    heading.textContent = title
    form.setAttribute('aria-labelledby', heading.id)
    const controls = document.createElement('div')
    controls.className = 'workspace-switcher-edit-actions'
    const cancel = button('Cancel', 'workspace-switcher-confirm')
    cancel.addEventListener('click', () => {
      renderMenu()
      panel.querySelector<HTMLElement>(`[data-edit="${kind}"]`)?.focus()
    })
    controls.append(cancel)
    form.append(heading, controls)
    panel.replaceChildren(form)
    return { form, controls, cancel }
  }

  function renameWorkspace(name: string) {
    const { form, controls } = editWorkspace('rename', 'Rename workspace')
    const input = document.createElement('input')
    input.type = 'text'
    input.required = true
    input.maxLength = WORKSPACE_NAME_MAX_LENGTH
    input.value = name
    input.setAttribute('aria-label', 'Workspace name')
    form.insertBefore(input, controls)
    const save = button('Save name', 'workspace-switcher-confirm workspace-switcher-primary')
    save.type = 'submit'
    save.disabled = true
    controls.append(save)
    input.addEventListener('input', () => {
      const value = input.value.trim()
      save.disabled = !value || value === name
    })
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (!save.disabled) perform('Rename workspace', () => actions.onRename(input.value.trim()))
    })
    input.focus()
    input.select()
  }

  function deleteWorkspace(name: string) {
    const { form, controls, cancel } = editWorkspace('delete', 'Delete workspace?')
    const description = document.createElement('p')
    description.textContent = `“${name}” will be removed from Home. Its folders and files stay on disk.`
    form.insertBefore(description, controls)
    const remove = button('Delete Workspace', 'workspace-switcher-confirm workspace-switcher-danger')
    remove.type = 'submit'
    controls.append(remove)
    form.addEventListener('submit', event => {
      event.preventDefault()
      perform('Delete workspace', actions.onDelete)
    })
    cancel.focus()
  }

  panel.addEventListener('beforetoggle', event => {
    const open = event.newState === 'open'
    if (open && editing) renderMenu()
    trigger.setAttribute('aria-expanded', String(open))
  })
  function openPanel() {
    if (trigger.hidden || trigger.disabled) return
    trigger.focus({ preventScroll: true })
    if (!panel.matches(':popover-open')) panel.showPopover({ source: trigger })
  }

  trigger.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' || trigger.disabled) return
    event.preventDefault()
    openPanel()
    const first =
      panel.querySelector<HTMLButtonElement>('[aria-current="true"]:enabled') ??
      panel.querySelector<HTMLButtonElement>('.workspace-switcher-open:enabled') ??
      panel.querySelector<HTMLButtonElement>('button:enabled')
    first?.focus()
  })

  return {
    open: openPanel,
    update(next: WorkspaceSwitcherState) {
      const { workspace, rootPath, projectName, unavailableFolders, busy } = next
      const nextSignature = JSON.stringify([
        workspace?.id,
        workspace?.name,
        workspace?.folders,
        rootPath,
        projectName,
        unavailableFolders,
      ])
      const visible = Boolean(workspace ?? rootPath)
      if (busy || !visible) panel.hidePopover()
      project.hidden = visible
      trigger.hidden = !visible
      trigger.disabled = Boolean(busy)
      if (nextSignature === signature) return
      signature = nextSignature
      state = next
      if (!visible) {
        delete host.dataset.workspaceSwitcher
        return
      }
      host.dataset.workspaceSwitcher = workspace ? 'workspace' : 'standalone'
      triggerName.textContent = workspace?.name ?? projectName
      triggerRoot.hidden = !workspace || !rootPath || projectName === workspace.name
      triggerRoot.textContent = projectName
      trigger.title = workspace ? `${workspace.name} workspace${rootPath ? ` · ${rootPath}` : ''}` : (rootPath ?? '')
      trigger.setAttribute(
        'aria-label',
        workspace
          ? `${workspace.name} workspace${rootPath ? ` · ${projectName}` : ''}`
          : `${projectName} folder actions`,
      )
      if (panel.contains(document.activeElement)) trigger.focus({ preventScroll: true })
      renderMenu()
    },
  }
}
