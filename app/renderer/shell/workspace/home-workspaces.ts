// Copyright (c) 2026 The Billy Company
import { workspaceFolderLabel } from '../../../shared/preferences/saved-workspaces.ts'
import type { SavedWorkspace } from '../../../shared/preferences/saved-workspaces.ts'
import { requireElement } from './dom.js'
import { workspaceGlyph } from './workspace-glyph.ts'
import './home-workspaces.css'

const plus =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10m-5-5h10"/></svg>'
const arrow =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h9m-4-4 4 4-4 4"/></svg>'

export const homeWorkspacesMarkup = `
  <section class="home-workspaces" aria-labelledby="home-workspaces-title" hidden>
    <header class="home-workspaces-header">
      <div>
        <h2 id="home-workspaces-title">Workspaces</h2>
        <p class="home-workspaces-empty" hidden>Save a group of folders to reopen together.</p>
      </div>
      <button class="home-workspaces-create" type="button">${plus}New Workspace…</button>
    </header>
    <ul class="home-workspaces-list" hidden></ul>
  </section>
`

export function createHomeWorkspaces(
  startScreen: HTMLElement,
  actions: { create: () => void; open: (id: string) => void },
) {
  const section = requireElement(startScreen, '.home-workspaces', HTMLElement)
  const create = requireElement(section, '.home-workspaces-create', HTMLButtonElement)
  const list = requireElement(section, '.home-workspaces-list', HTMLUListElement)
  const empty = requireElement(section, '.home-workspaces-empty', HTMLElement)
  const document = section.ownerDocument
  let opening = false
  let signature: string | undefined
  let previousIds = new Set<string>()
  create.addEventListener('click', actions.create)

  return {
    get visible() {
      return !section.hidden
    },
    setVisible(visible: boolean) {
      section.hidden = !visible
    },
    setOpening(next: boolean) {
      opening = next
      create.disabled = opening
      for (const button of list.querySelectorAll('button')) button.disabled = opening
    },
    setWorkspaces(workspaces: SavedWorkspace[]) {
      const next = JSON.stringify(workspaces.map(({ id, name, folders }) => [id, name, folders]))
      if (signature === next) return
      signature = next
      const focused = document.activeElement
      const focusedId =
        focused instanceof HTMLButtonElement && list.contains(focused) ? focused.dataset.workspaceId : undefined
      let focusTarget: HTMLButtonElement | undefined
      const items = workspaces.map(workspace => {
        const item = document.createElement('li')
        const button = document.createElement('button')
        const count = workspace.folders.length
        const folders = workspace.folders.slice(0, 3).map(workspaceFolderLabel).join(', ')
        const summary = `${count} ${count === 1 ? 'folder' : 'folders'} · ${folders}${count > 3 ? ', …' : ''}`
        item.classList.toggle('home-workspace-arriving', !previousIds.has(workspace.id))
        button.type = 'button'
        button.className = 'home-workspace-card'
        button.dataset.workspaceId = workspace.id
        button.disabled = opening
        button.title = workspace.folders.join('\n')
        button.innerHTML = `
          <span class="home-workspace-glyph" aria-hidden="true">${workspaceGlyph}</span>
          <span class="home-workspace-copy"><strong></strong><span></span></span>
          <span class="home-workspace-arrow">${arrow}</span>
        `
        requireElement(button, 'strong', HTMLElement).textContent = workspace.name
        requireElement(button, '.home-workspace-copy > span', HTMLElement).textContent = summary
        button.addEventListener('click', () => actions.open(workspace.id))
        if (workspace.id === focusedId) focusTarget = button
        item.append(button)
        return item
      })
      list.replaceChildren(...items)
      empty.hidden = Boolean(items.length)
      list.hidden = !items.length
      previousIds = new Set(workspaces.map(workspace => workspace.id))
      if (focusedId) (focusTarget ?? create).focus({ preventScroll: true })
    },
  }
}
