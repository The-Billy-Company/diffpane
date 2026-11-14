import type { DiffpaneApi } from '../../../electron/runtime/window/preload.ts'
import { agentProviderNames } from '../../../shared/agent-threads.ts'
import type { AgentThread, AgentThreadEvent, AgentThreadFile } from '../../../shared/agent-threads.ts'
import { reportError } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import './agent-threads.css'

const labels = {
  user: 'You',
  assistant: 'Assistant',
  tool: 'Tool',
  edit: 'File change',
  status: 'Status',
}
const MAX_EVENTS = 500

interface ThreadPanelOptions {
  api: DiffpaneApi['agentThreads']
  button: HTMLButtonElement
  changeMode: (active: boolean) => void
  openWorkspaceFile: (file: AgentThreadFile) => unknown
}

export function createAgentThreadPanel(host: HTMLElement, options: ThreadPanelOptions) {
  const { api, button, changeMode, openWorkspaceFile } = options
  host.className = 'agent-threads'
  host.innerHTML = `
    <div class="agent-thread-toolbar">
      <button type="button" class="claude-button" data-chat>Creature chat</button>
      <button type="button" class="claude-button" data-list hidden>All threads</button>
      <button type="button" class="claude-button" data-refresh>Refresh</button>
    </div>
    <div class="agent-thread-heading">
      <div class="agent-thread-title-row">
        <h3>Agent threads</h3>
        <span class="agent-thread-live" hidden>Following</span>
      </div>
      <p class="agent-thread-context" hidden></p>
      <p class="agent-thread-status" role="status"></p>
    </div>
    <div class="agent-thread-search" role="search">
      <input type="search" aria-label="Search agent threads" placeholder="Search threads" />
    </div>
    <div class="agent-thread-list" aria-label="Agent threads"></div>
    <div class="agent-thread-events" role="log" aria-live="off" aria-label="Agent activity" tabindex="0" hidden></div>
    <section class="agent-thread-preview" aria-label="File preview" hidden>
      <header>
        <strong></strong>
        <button type="button" class="claude-button" data-close-preview>Close preview</button>
      </header>
      <p hidden>Showing the first 256 KiB</p>
      <pre tabindex="0"></pre>
    </section>`
  const chat = requireElement(host, '[data-chat]', HTMLButtonElement)
  const back = requireElement(host, '[data-list]', HTMLButtonElement)
  const refresh = requireElement(host, '[data-refresh]', HTMLButtonElement)
  const title = requireElement(host, 'h3', HTMLHeadingElement)
  const live = requireElement(host, '.agent-thread-live', HTMLSpanElement)
  const context = requireElement(host, '.agent-thread-context', HTMLParagraphElement)
  const status = requireElement(host, '.agent-thread-status', HTMLParagraphElement)
  const search = requireElement(host, '.agent-thread-search', HTMLDivElement)
  const query = requireElement(search, 'input', HTMLInputElement)
  const list = requireElement(host, '.agent-thread-list', HTMLDivElement)
  const noMatches = document.createElement('p')
  noMatches.className = 'agent-thread-no-matches'
  noMatches.textContent = 'No matching threads.'
  noMatches.hidden = true
  const events = requireElement(host, '.agent-thread-events', HTMLDivElement)
  const preview = requireElement(host, '.agent-thread-preview', HTMLElement)
  const previewTitle = requireElement(preview, 'strong', HTMLElement)
  const previewContents = requireElement(preview, 'pre', HTMLPreElement)
  const previewLimit = requireElement(preview, 'p', HTMLParagraphElement)
  const closePreview = requireElement(preview, '[data-close-preview]', HTMLButtonElement)

  let subscription = ''
  let listTimer = 0
  let listing = false
  let listKey = ''
  let selected: AgentThread | undefined
  let selectedFile: AgentThreadFile | undefined
  let fileButton: HTMLButtonElement | undefined
  let fileRequest = 0

  function showError(error: unknown) {
    status.textContent = reportError(error, { silent: true }).message
  }

  function stopFollowing() {
    if (subscription) void api.stop(subscription).catch((error: unknown) => reportError(error, { silent: true }))
    subscription = ''
    selected = undefined
    selectedFile = undefined
    fileButton = undefined
    events.replaceChildren()
    previewContents.textContent = ''
    preview.hidden = true
  }

  async function readFile(file: AgentThreadFile, focus: boolean) {
    const current = subscription
    const request = ++fileRequest
    try {
      const result = await api.file(current, file.path)
      if (subscription !== current || request !== fileRequest) return
      if (result.kind === 'workspace') {
        if (focus) await openWorkspaceFile({ ...file, path: result.path })
        return
      }
      previewTitle.textContent = file.path.split(/[\\/]/u).at(-1) ?? file.path
      previewTitle.title = file.path
      if (previewContents.textContent !== result.text) previewContents.textContent = result.text
      previewLimit.hidden = !result.limited
      preview.hidden = false
      if (focus) {
        previewContents.focus({ preventScroll: true })
        if (file.line) {
          const lineHeight = Number.parseFloat(getComputedStyle(previewContents).lineHeight)
          previewContents.scrollTop = (file.line - 1) * lineHeight
        }
      }
    } catch (error) {
      if (subscription !== current || request !== fileRequest) return
      if (focus) showError(error)
      else if (!preview.hidden) previewContents.textContent = 'This file is no longer available.'
    }
  }

  function appendEvent(event: AgentThreadEvent) {
    const article = document.createElement('article')
    article.className = 'agent-thread-event'
    article.dataset.kind = event.kind
    const label = document.createElement('h4')
    label.textContent =
      event.kind === 'assistant' && selected ? agentProviderNames[selected.provider] : labels[event.kind]
    const body = document.createElement('p')
    body.textContent = event.text
    article.append(label, body)
    for (const file of event.files ?? []) {
      const link = document.createElement('button')
      link.type = 'button'
      link.className = 'agent-thread-file'
      link.textContent = `${file.path.split(/[\\/]/u).at(-1) ?? file.path}${file.line ? `:${file.line}` : ''}`
      link.title = file.path
      link.addEventListener('click', () => {
        if (!preview.hidden && selectedFile?.path !== file.path) preview.hidden = true
        fileButton = link
        selectedFile = file
        void readFile(file, true).catch(showError)
      })
      article.append(link)
    }
    return article
  }

  const unsubscribe = api.onUpdate(update => {
    if (update.subscription !== subscription) return
    status.textContent =
      update.error ?? (events.childElementCount || update.events.length ? '' : 'Waiting for activity…')
    live.textContent = update.error ? 'Reconnecting' : 'Following'
    const follow = events.scrollHeight - events.scrollTop - events.clientHeight < 48
    const fragment = document.createDocumentFragment()
    for (const event of update.events.slice(-MAX_EVENTS)) fragment.append(appendEvent(event))
    events.append(fragment)
    while (events.childElementCount > MAX_EVENTS) events.firstElementChild?.remove()
    if (follow) events.scrollTop = events.scrollHeight
    if (!preview.hidden && selectedFile) {
      const path = selectedFile.path
      if (update.events.some(event => event.kind === 'edit' && event.files?.some(file => file.path === path)))
        void readFile(selectedFile, false).catch(showError)
    }
  })

  async function followThread(thread: AgentThread) {
    stopFollowing()
    window.clearTimeout(listTimer)
    const current = crypto.randomUUID()
    subscription = current
    selected = thread
    title.textContent = thread.title
    title.title = thread.title
    context.textContent = [agentProviderNames[thread.provider], thread.cwd].filter(Boolean).join(' · ')
    context.hidden = false
    live.textContent = 'Following'
    live.hidden = false
    search.hidden = true
    list.hidden = true
    back.hidden = false
    refresh.hidden = true
    events.hidden = false
    status.textContent = 'Waiting for activity…'
    events.focus()
    try {
      await api.follow(thread.id, current)
    } catch (error) {
      if (subscription !== current) return
      live.hidden = true
      showError(error)
    }
  }

  function filterList() {
    const terms = query.value.trim().toLowerCase().split(/\s+/u)
    const choices = list.querySelectorAll<HTMLButtonElement>('.agent-thread-choice')
    let matches = 0
    for (const choice of choices) {
      const searchable = choice.textContent.toLowerCase()
      choice.hidden = !terms.every(term => searchable.includes(term))
      if (!choice.hidden) matches++
    }
    noMatches.hidden = matches > 0 || !choices.length
  }

  async function refreshList() {
    if (host.hidden || selected || listing) return
    window.clearTimeout(listTimer)
    listing = true
    try {
      const result = await api.list()
      if (host.hidden || selected) return
      const focusedId =
        document.activeElement instanceof HTMLElement ? document.activeElement.dataset.thread : undefined
      const key = JSON.stringify(result.threads.map(thread => [thread.id, thread.active, thread.title, thread.cwd]))
      if (key !== listKey) {
        listKey = key
        const fragment = document.createDocumentFragment()
        let focused: HTMLButtonElement | undefined
        for (const thread of result.threads) {
          const choice = document.createElement('button')
          choice.type = 'button'
          choice.className = 'agent-thread-choice'
          choice.dataset.thread = thread.id
          const name = document.createElement('strong')
          name.textContent = thread.title
          const meta = document.createElement('span')
          meta.textContent = [agentProviderNames[thread.provider], thread.active && 'Active', thread.cwd]
            .filter(Boolean)
            .join(' · ')
          choice.title = meta.textContent
          choice.append(name, meta)
          choice.addEventListener('click', () => void followThread(thread).catch(showError))
          fragment.append(choice)
          if (focusedId === thread.id) focused = choice
        }
        list.replaceChildren(fragment, noMatches)
        filterList()
        if (focused) focused.focus({ preventScroll: true })
        else if (focusedId) refresh.focus({ preventScroll: true })
      }
      status.textContent = [
        !result.threads.length && 'No local agent threads found.',
        result.unavailable.length &&
          `Unavailable: ${result.unavailable.map(provider => agentProviderNames[provider]).join(', ')}`,
      ]
        .filter(Boolean)
        .join(' ')
    } catch (error) {
      if (!host.hidden && !selected) showError(error)
    } finally {
      listing = false
      if (!host.hidden && !selected) listTimer = window.setTimeout(() => void refreshList(), 3000)
    }
  }

  function openList() {
    stopFollowing()
    host.hidden = false
    changeMode(true)
    title.textContent = 'Agent threads'
    title.title = ''
    context.hidden = live.hidden = events.hidden = back.hidden = true
    list.hidden = search.hidden = refresh.hidden = false
    status.textContent = 'Finding local agent threads…'
    query.focus()
    void refreshList().catch(showError)
  }

  function close() {
    if (host.hidden) return
    host.hidden = true
    window.clearTimeout(listTimer)
    stopFollowing()
    changeMode(false)
  }

  button.addEventListener('click', openList)
  back.addEventListener('click', openList)
  refresh.addEventListener('click', () => void refreshList())
  query.addEventListener('input', filterList)
  chat.addEventListener('click', () => {
    close()
    button.focus()
  })
  closePreview.addEventListener('click', () => {
    fileRequest++
    selectedFile = undefined
    preview.hidden = true
    if (fileButton?.isConnected) fileButton.focus()
    else events.focus()
  })

  return {
    close,
    dispose() {
      close()
      unsubscribe()
      button.removeEventListener('click', openList)
    },
  }
}
