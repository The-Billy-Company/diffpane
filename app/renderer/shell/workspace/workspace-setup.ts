import { WORKSPACE_NAME_MAX_LENGTH, workspaceFolderLabel } from '../../../shared/preferences/saved-workspaces.ts'
import { appError } from '../../../shared/recovery/app-errors.ts'
import { runTask } from '../recovery/errors.ts'
import { requireElement } from './dom.js'
import { workspaceGlyph } from './workspace-glyph.ts'
import './workspace-setup.css'

interface SetupOptions {
  folders: string[]
  pick: () => Promise<string[]>
  save: (name: string, folders: string[]) => Promise<void>
}

export function showWorkspaceSetup({ folders: initialFolders, pick, save }: SetupOptions): Promise<void> {
  const dialog = document.createElement('dialog')
  dialog.className = 'workspace-setup'
  dialog.setAttribute('aria-labelledby', 'workspace-setup-title')
  dialog.innerHTML = `<form>
    <header class="workspace-setup-heading">
      <span class="workspace-setup-glyph" aria-hidden="true">${workspaceGlyph}</span>
      <div><h2 id="workspace-setup-title">New workspace</h2><p>Saved workspaces appear on Home.</p></div>
    </header>
    <label class="workspace-setup-name">Workspace name<input autocomplete="off" maxlength="${WORKSPACE_NAME_MAX_LENGTH}" required></label>
    <div class="workspace-setup-folders">
      <h3 id="workspace-setup-folders">Folders</h3>
      <button type="button" data-setup="add">＋ Add folders…</button>
    </div>
    <ul aria-labelledby="workspace-setup-folders"></ul>
    <p role="alert" class="workspace-setup-error" hidden></p>
    <footer><button type="button" data-setup="cancel">Cancel</button><button type="submit">Save and open</button></footer>
  </form>`
  const form = requireElement(dialog, 'form', HTMLFormElement)
  const input = requireElement(dialog, 'input', HTMLInputElement)
  const list = requireElement(dialog, 'ul', HTMLUListElement)
  const add = requireElement(dialog, '[data-setup="add"]', HTMLButtonElement)
  const cancel = requireElement(dialog, '[data-setup="cancel"]', HTMLButtonElement)
  const submit = requireElement(dialog, '[type="submit"]', HTMLButtonElement)
  const error = requireElement(dialog, '[role="alert"]', HTMLElement)
  let folders = [...initialFolders]
  let busy = false

  function updateControls() {
    form.setAttribute('aria-busy', String(busy))
    input.disabled = add.disabled = cancel.disabled = busy
    submit.disabled = busy || folders.length === 0
    for (const button of list.querySelectorAll('button')) button.disabled = busy
  }

  function renderFolders() {
    list.replaceChildren(
      ...folders.map(folder => {
        const item = document.createElement('li')
        const label = document.createElement('span')
        const name = document.createElement('strong')
        name.textContent = workspaceFolderLabel(folder)
        const location = document.createElement('span')
        location.textContent = location.title = folder
        label.append(name, location)
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.textContent = '×'
        remove.title = `Remove ${name.textContent}`
        remove.setAttribute('aria-label', `Remove ${folder}`)
        remove.addEventListener('click', () => {
          folders = folders.filter(path => path !== folder)
          renderFolders()
          add.focus()
        })
        item.append(label, remove)
        return item
      }),
    )
    updateControls()
  }

  async function perform(action: () => Promise<void>, focus: HTMLElement, saving = false) {
    if (busy) return
    busy = true
    if (saving) submit.textContent = 'Saving…'
    error.hidden = true
    updateControls()
    try {
      await action()
    } catch (cause) {
      error.textContent = appError(cause).message
      error.hidden = false
    } finally {
      busy = false
      if (saving) submit.textContent = 'Save and open'
      updateControls()
      if (dialog.open) focus.focus()
    }
  }

  input.value = initialFolders[0] ? workspaceFolderLabel(initialFolders[0]).slice(0, input.maxLength) : ''
  input.addEventListener('input', () => input.setCustomValidity(''))
  form.addEventListener('submit', event => {
    event.preventDefault()
    const name = input.value.trim()
    if (!name) {
      input.setCustomValidity('Enter a workspace name.')
      input.reportValidity()
      return
    }
    runTask('Save workspace', () =>
      perform(
        async () => {
          await save(name, folders)
          dialog.close()
        },
        input,
        true,
      ),
    )
  })
  add.addEventListener('click', () => {
    runTask('Pick workspace folders', () =>
      perform(async () => {
        folders = [...new Set([...folders, ...(await pick())])]
        renderFolders()
      }, add),
    )
  })
  cancel.addEventListener('click', () => dialog.close())
  dialog.addEventListener('cancel', event => {
    if (busy) event.preventDefault()
  })

  const done = new Promise<void>(resolve => {
    dialog.addEventListener(
      'close',
      () => {
        dialog.remove()
        resolve()
      },
      { once: true },
    )
  })
  renderFolders()
  document.body.append(dialog)
  dialog.showModal()
  input.focus()
  input.select()
  return done
}
