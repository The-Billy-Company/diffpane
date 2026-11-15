import type { DiffpaneApi } from '../../../electron/runtime/window/preload.ts'
import { agentProviderNames } from '../../../shared/agent-threads.ts'
import type { AgentProvider, AgentThread, AgentThreadFile } from '../../../shared/agent-threads.ts'
import { reportError } from '../../shell/recovery/errors.ts'
import { requireElement } from '../../shell/workspace/dom.js'
import { drawThreadTrail } from '../art/assistant.ts'
import { renderAgentThreadConversation } from './agent-thread-conversation.ts'
import { createAgentThreadMinimap } from './agent-thread-minimap.ts'
import antigravityLogo from './provider-logos/antigravity.png'
import claudeCodeLogo from './provider-logos/claude-code.png'
import codexLogo from './provider-logos/codex.png'
import cursorDarkLogo from './provider-logos/cursor-dark.png'
import cursorLightLogo from './provider-logos/cursor-light.png'
import './agent-threads.css'

const glyphs = {
  activity: '<path d="M1.5 8h3l1.7-4.5 3.1 9 1.9-4.5h3.3"/>',
  arrow: '<path d="M13 8H3m4-4L3 8l4 4"/>',
  next: '<path d="m6 4 4 4-4 4"/>',
  sidebar: '<rect x="2" y="3.25" width="12" height="9.5" rx="1.4"/><path d="M6.25 3.25v9.5"/>',
  close: '<path d="m4 4 8 8m0-8-8 8"/>',
  folder:
    '<path d="M2 5a1.5 1.5 0 0 1 1.5-1.5h3L8 5h4.5A1.5 1.5 0 0 1 14 6.5V11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11z"/>',
  grid: '<rect x="2.5" y="2.5" width="4" height="4" rx=".7"/><rect x="9.5" y="2.5" width="4" height="4" rx=".7"/><rect x="2.5" y="9.5" width="4" height="4" rx=".7"/><rect x="9.5" y="9.5" width="4" height="4" rx=".7"/>',
  refresh:
    '<path d="M13 6a5.1 5.1 0 0 0-8.6-1.7L2.5 6m0 0h3.3M2.5 6V2.7M3 10a5.1 5.1 0 0 0 8.6 1.7l1.9-1.7m0 0h-3.3m3.3 0v3.3"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3 3"/>',
  down: '<path d="M8 3.25v9.5m-3.75-3.75L8 12.75 11.75 9"/>',
}

const providerLogos: Record<AgentProvider, string> = {
  codex: codexLogo, // Codex app mark from the ChatGPT desktop bundle.
  claude: claudeCodeLogo, // Anthropic's Claude Code VS Code extension icon.
  antigravity: antigravityLogo, // Full-color mark from antigravity.google/press.
  cursor: cursorDarkLogo, // 2D cube variants from cursor.com/brand.
}

const providers = ['codex', 'claude', 'antigravity', 'cursor'] satisfies AgentProvider[]
const stateLabels = { running: 'Running', idle: 'Idle', recent: 'Recent', unknown: 'Unknown', stale: 'Stale' }
const NO_PROJECT = 'unassigned'
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

type ThreadState = keyof typeof stateLabels

interface ThreadPanelOptions {
  api: DiffpaneApi['agentThreads']
  openWorkspaceFile: (file: AgentThreadFile) => unknown
  onVisibilityChange?: (visible: boolean) => void
}

function icon(name: keyof typeof glyphs) {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name]}</svg>`
}

function node<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, text?: string) {
  const element = document.createElement(tag)
  element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function basename(path: string) {
  return path.replace(/[\\/]+$/u, '').match(/[^\\/]+$/u)?.[0] ?? path
}

function threadCount(count: number) {
  return `${count} ${count === 1 ? 'thread' : 'threads'}`
}

function projectOf(thread: AgentThread) {
  return thread.projectRoot ?? (thread.cwd || NO_PROJECT)
}

function projectName(path: string) {
  return path === NO_PROJECT ? 'No project' : basename(path)
}

function providerLogo(provider: AgentProvider) {
  const dark = `<img class="agent-thread-provider-logo" alt="" src="${providerLogos[provider]}">`
  return provider === 'cursor'
    ? `${dark}<img class="agent-thread-provider-logo agent-thread-provider-logo-light" alt="" src="${cursorLightLogo}">`
    : dark
}

function providerMark(provider: AgentProvider) {
  const mark = node('span', 'agent-thread-provider-mark')
  mark.dataset.provider = provider
  mark.innerHTML = providerLogo(provider)
  return mark
}

function renderState(element: HTMLElement, state: ThreadState) {
  element.dataset.state = state
  element.textContent = stateLabels[state]
}

function renderTime(element: HTMLTimeElement, stamp: number, now: number, absolute = false) {
  const date = new Date(stamp)
  element.hidden = stamp <= 0 || !Number.isFinite(date.getTime())
  if (element.hidden) return
  const elapsed = Math.max(0, now - stamp)
  element.dateTime = date.toISOString()
  element.title = timeFormat.format(stamp)
  element.textContent =
    absolute || elapsed >= 604_800_000
      ? absolute
        ? element.title
        : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : elapsed < 60_000
        ? 'Just now'
        : elapsed < 3_600_000
          ? `${Math.floor(elapsed / 60_000)}m ago`
          : elapsed < 86_400_000
            ? `${Math.floor(elapsed / 3_600_000)}h ago`
            : `${Math.floor(elapsed / 86_400_000)}d ago`
}

export function createAgentThreadPanel(
  host: HTMLElement,
  { api, openWorkspaceFile, onVisibilityChange }: ThreadPanelOptions,
) {
  host.classList.add('agent-threads')
  host.hidden = true
  host.setAttribute('aria-labelledby', 'agent-threads-title')
  host.innerHTML = `
    <header class="agent-thread-topbar">
      <button class="agent-thread-control agent-thread-sidebar-toggle" type="button" data-projects-toggle aria-controls="agent-thread-projects">
        ${icon('sidebar')}
      </button>
      <h1 class="agent-thread-app-title" id="agent-threads-title" data-app-title>${icon('activity')}<span>Agent threads</span></h1>
      <button class="agent-thread-control" type="button" data-back aria-label="Back to threads" hidden>${icon('arrow')}<span>Threads</span></button>
      <div class="agent-thread-topbar-end">
        <span class="agent-thread-sync" role="status" data-sync></span>
        <button class="agent-thread-control" type="button" data-refresh aria-label="Refresh threads" title="Refresh threads">${icon('refresh')}<span>Refresh</span></button>
        <span class="agent-thread-topbar-rule" aria-hidden="true"></span>
        <button class="agent-thread-control" type="button" data-close aria-label="Back to workspace" title="Back to workspace">${icon('close')}<span>Workspace</span></button>
      </div>
    </header>
    <div class="agent-thread-browser" data-browser data-projects-open="true">
      <nav id="agent-thread-projects" class="agent-thread-projects" aria-label="Projects">
        <div class="agent-thread-projects-content">
          <h2>Projects</h2>
          <div data-projects></div>
        </div>
      </nav>
      <section class="agent-thread-roster" aria-label="Threads" tabindex="-1" data-roster>
        <div class="agent-thread-filters">
          <div class="agent-thread-query-tools">
            <label class="agent-thread-search">${icon('search')}<input type="search" aria-label="Search threads" placeholder="Search threads" /></label>
            <button class="agent-thread-control agent-thread-running" type="button" aria-pressed="false" data-running><span></span>Running</button>
          </div>
          <div class="agent-thread-providers" role="group" aria-label="Filter by agent">
            <button class="agent-thread-source" type="button" aria-pressed="true" data-any-agent>All agents</button>
            ${providers
              .map(
                provider => `
              <button class="agent-thread-source" type="button" aria-pressed="false" data-source="${provider}" data-provider="${provider}">
                ${providerLogo(provider)}<span>${agentProviderNames[provider]}</span><span class="agent-thread-source-count" data-source-count></span>
              </button>`,
              )
              .join('')}
          </div>
        </div>
        <div class="agent-thread-list" data-list>
          <div class="agent-thread-list-content" data-list-content></div>
        </div>
      </section>
    </div>
    <section class="agent-thread-detail" aria-label="Conversation" data-detail hidden>
      <header class="agent-thread-detail-header">
        <div class="agent-thread-detail-heading">
          <div class="agent-thread-detail-meta">
            <span class="agent-thread-detail-provider" data-detail-provider></span>
            <span class="agent-thread-detail-project" data-detail-project></span>
            <span class="agent-thread-state" data-detail-state></span>
          </div>
          <h2 tabindex="-1" data-detail-title></h2>
          <div class="agent-thread-detail-context">
            <time data-detail-time></time>
            <span class="agent-thread-cwd" data-detail-cwd></span>
          </div>
        </div>
        <button class="agent-thread-control agent-thread-jump" type="button" data-latest hidden>${icon('down')} Latest</button>
      </header>
      <div class="agent-thread-reading">
        <div class="agent-thread-transcript" data-conversation></div>
      </div>
      <section class="agent-thread-preview" aria-label="File preview" data-preview hidden>
        <header>
          <strong></strong>
          <button type="button" class="agent-thread-control" data-close-preview aria-label="Close file preview" title="Close file preview">${icon('close')}</button>
        </header>
        <p hidden>Showing the first 256 KiB</p>
        <pre tabindex="0"></pre>
      </section>
    </section>`

  const browser = requireElement(host, '[data-browser]', HTMLDivElement)
  const sidebar = requireElement(host, '#agent-thread-projects', HTMLElement)
  const projectNav = requireElement(sidebar, '[data-projects]', HTMLDivElement)
  const sidebarToggle = requireElement(host, '[data-projects-toggle]', HTMLButtonElement)
  const back = requireElement(host, '[data-back]', HTMLButtonElement)
  const appTitle = requireElement(host, '[data-app-title]', HTMLElement)
  const sync = requireElement(host, '[data-sync]', HTMLElement)
  const roster = requireElement(host, '[data-roster]', HTMLElement)
  const refresh = requireElement(host, '[data-refresh]', HTMLButtonElement)
  const query = requireElement(host, 'input[type=search]', HTMLInputElement)
  const running = requireElement(host, '[data-running]', HTMLButtonElement)
  const list = requireElement(host, '[data-list]', HTMLDivElement)
  const listContent = requireElement(list, '[data-list-content]', HTMLDivElement)
  const allAgents = requireElement(host, '[data-any-agent]', HTMLButtonElement)
  const sources = new Map(
    providers.map(provider => {
      const button = requireElement(host, `[data-source="${provider}"]`, HTMLButtonElement)
      return [provider, { button, count: requireElement(button, '[data-source-count]', HTMLElement) }]
    }),
  )

  const detail = requireElement(host, '[data-detail]', HTMLElement)
  const detailTitle = requireElement(detail, '[data-detail-title]', HTMLHeadingElement)
  const detailProvider = requireElement(detail, '[data-detail-provider]', HTMLElement)
  const detailProject = requireElement(detail, '[data-detail-project]', HTMLElement)
  const detailState = requireElement(detail, '[data-detail-state]', HTMLElement)
  const detailCwd = requireElement(detail, '[data-detail-cwd]', HTMLElement)
  const detailTime = requireElement(detail, '[data-detail-time]', HTMLTimeElement)
  const conversation = requireElement(detail, '[data-conversation]', HTMLDivElement)
  const minimap = createAgentThreadMinimap(conversation)
  requireElement(detail, '.agent-thread-reading', HTMLDivElement).append(minimap.element)
  const latest = requireElement(detail, '[data-latest]', HTMLButtonElement)
  const preview = requireElement(detail, '[data-preview]', HTMLElement)
  const previewTitle = requireElement(preview, 'strong', HTMLElement)
  const previewContents = requireElement(preview, 'pre', HTMLPreElement)
  const previewLimit = requireElement(preview, 'p', HTMLParagraphElement)

  let threads = new Map<string, AgentThread>()
  const rowButtons = new Map<string, HTMLButtonElement>()
  let unavailable = new Set<AgentProvider>()
  let loaded = false
  let listError = false
  let listing = false
  let reading = false
  let disposed = false
  let lastChecked = 0
  let projectFilter = ''
  let providerFilter: AgentProvider | undefined
  let runningOnly = false
  let projectsOpen = true
  let returnFocus: HTMLElement | null = null
  let previousListTop = 0
  let selected: AgentThread | undefined
  let selection = ''
  let fileButton: HTMLButtonElement | undefined
  let fileRequest = 0

  function stateOf(thread: AgentThread): ThreadState {
    return listError || unavailable.has(thread.provider) ? 'stale' : (thread.status ?? 'unknown')
  }

  function updateTopbar() {
    sidebarToggle.hidden = Boolean(selected)
    appTitle.classList.toggle('agent-thread-app-title-compact', Boolean(selected))
    back.hidden = !selected
    sync.hidden = Boolean(selected)
    const label = selected ? 'Refresh conversation' : 'Refresh threads'
    refresh.setAttribute('aria-label', label)
    refresh.title = label
    refresh.disabled = selected ? reading : listing
  }

  function setProjectsOpen(open: boolean) {
    projectsOpen = open
    browser.dataset.projectsOpen = String(open)
    sidebar.inert = !open
    sidebarToggle.setAttribute('aria-expanded', String(open))
    const label = open ? 'Hide projects' : 'Show projects'
    sidebarToggle.setAttribute('aria-label', label)
    sidebarToggle.title = label
  }

  function selectProject(path: string) {
    projectFilter = path
    applyFilters()
  }

  function projectButton(path: string, title: string, count: number) {
    const button = node('button', 'agent-thread-project')
    button.type = 'button'
    button.title = path && path !== NO_PROJECT ? path : title
    button.setAttribute('aria-current', String(projectFilter === path))
    button.innerHTML = icon(path ? 'folder' : 'grid')
    button.append(
      node('span', 'agent-thread-project-name', title),
      node('span', 'agent-thread-project-count', String(count)),
    )
    button.addEventListener('click', () => selectProject(path))
    return button
  }

  function createThreadRow(thread: AgentThread, now: number) {
    const button = node('button', 'agent-thread-row')
    button.type = 'button'
    const content = node('span', 'agent-thread-row-content')
    const title = node('strong', 'agent-thread-row-title', thread.title)
    title.title = thread.title
    const activity = node('span', 'agent-thread-row-activity')
    const excerpt = thread.activity?.replace(/\s+/gu, ' ').trim()
    const worktree = thread.cwd && thread.cwd !== projectOf(thread) ? basename(thread.cwd) : ''
    activity.textContent = [agentProviderNames[thread.provider], worktree, excerpt].filter(Boolean).join(' · ')
    content.append(title, activity)
    const meta = node('span', 'agent-thread-row-meta')
    const state = node('span', 'agent-thread-state')
    renderState(state, stateOf(thread))
    const time = node('time', 'agent-thread-time')
    renderTime(time, thread.updatedAt, now)
    meta.append(state, time)
    const arrow = node('span', 'agent-thread-row-arrow')
    arrow.innerHTML = icon('next')
    button.append(providerMark(thread.provider), content, meta, arrow)
    button.addEventListener('click', () => openThread(thread))
    rowButtons.set(thread.id, button)
    return button
  }

  function renderRoster() {
    const terms = query.value.trim().toLowerCase().split(/\s+/u)
    const now = lastChecked || Date.now()
    const projects = new Map<string, { total: number; matches: AgentThread[] }>()
    const byProvider = new Map<AgentProvider, number>()
    for (const thread of threads.values()) {
      const path = projectOf(thread)
      const group = projects.get(path) ?? { total: 0, matches: [] }
      projects.set(path, group)
      group.total++
      if (projectFilter && projectFilter !== path) continue
      byProvider.set(thread.provider, (byProvider.get(thread.provider) ?? 0) + 1)
      if (providerFilter && providerFilter !== thread.provider) continue
      if (runningOnly && stateOf(thread) !== 'running') continue
      const searchable = [thread.title, thread.activity, thread.cwd, path, agentProviderNames[thread.provider]]
        .join(' ')
        .toLowerCase()
      if (!terms.every(term => searchable.includes(term))) continue
      group.matches.push(thread)
    }

    allAgents.setAttribute('aria-pressed', String(!providerFilter))
    for (const [provider, source] of sources) {
      source.button.setAttribute('aria-pressed', String(providerFilter === provider))
      source.count.textContent = loaded ? String(byProvider.get(provider) ?? 0) : ''
      const missing = unavailable.has(provider)
      source.button.dataset.unavailable = String(missing)
      source.button.title = missing ? `${agentProviderNames[provider]} sessions could not be refreshed` : ''
    }

    const scope = projectFilter === NO_PROJECT ? 'with no project' : `in ${projectName(projectFilter)}`
    roster.setAttribute('aria-label', projectFilter ? `Threads ${scope}` : 'Threads')

    const activeProject =
      document.activeElement instanceof HTMLButtonElement && projectNav.contains(document.activeElement)
        ? [...projectNav.children].indexOf(document.activeElement)
        : -1
    projectNav.replaceChildren(
      projectButton('', 'All projects', threads.size),
      ...[...projects].map(([path, count]) => projectButton(path, projectName(path), count.total)),
    )
    const previousProject = projectNav.children.item(activeProject)
    if (previousProject instanceof HTMLElement) previousProject.focus({ preventScroll: true })

    rowButtons.clear()
    const content = document.createDocumentFragment()
    for (const [path, group] of projects) {
      if (!group.matches.length && path !== projectFilter) continue
      const section = node('section', 'agent-thread-group')
      const heading = node('header', 'agent-thread-group-heading')
      heading.innerHTML = icon('folder')
      heading.append(node('h2', '', projectName(path)), node('span', '', threadCount(group.matches.length)))
      heading.title = path === NO_PROJECT ? '' : path
      section.append(heading)
      if (group.matches.length) {
        const rows = node('div', 'agent-thread-group-rows')
        rows.append(...group.matches.map(thread => createThreadRow(thread, now)))
        section.append(rows)
      }
      content.append(section)
    }
    if (!rowButtons.size) {
      const empty = node('div', 'agent-thread-empty')
      const art = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      art.setAttribute('class', 'agent-thread-empty-art')
      art.setAttribute('viewBox', '9 4 69 50')
      art.setAttribute('aria-hidden', 'true')
      art.setAttribute('stroke-linecap', 'round')
      art.setAttribute('stroke-linejoin', 'round')
      if (!listing) {
        drawThreadTrail(art)
        empty.append(art)
      }
      const title =
        !loaded && listing
          ? 'Finding local threads…'
          : listError
            ? 'Couldn’t load local threads'
            : threads.size
              ? 'No matching threads'
              : 'No local threads found'
      empty.append(node('p', 'agent-thread-empty-title', title))
      if (loaded || listError) {
        empty.append(
          node(
            'p',
            '',
            listError
              ? 'Use Refresh to try again.'
              : threads.size
                ? 'Try a different search or filter.'
                : 'Saved sessions will appear here when you refresh.',
          ),
        )
      }
      const emptyContainer = content.firstElementChild ?? content
      emptyContainer.append(empty)
    }
    const focusedId =
      document.activeElement instanceof HTMLButtonElement && list.contains(document.activeElement)
        ? document.activeElement.dataset.threadId
        : undefined
    for (const [id, button] of rowButtons) button.dataset.threadId = id
    listContent.replaceChildren(content)
    if (focusedId) (rowButtons.get(focusedId) ?? query).focus({ preventScroll: true })
  }

  function applyFilters() {
    renderRoster()
    list.scrollTop = 0
  }

  function clearSelection() {
    const previous = selection
    selection = ''
    reading = false
    fileRequest++
    if (previous) void api.clear(previous).catch((error: unknown) => reportError(error, { silent: true }))
    minimap.setTranscript()
    preview.hidden = true
    previewContents.textContent = ''
    fileButton = undefined
  }

  async function readFile(file: AgentThreadFile, button?: HTMLButtonElement) {
    const current = selection
    const request = ++fileRequest
    fileButton = button
    try {
      const result = await api.file(current, file.path)
      if (selection !== current || request !== fileRequest) return
      if (result.kind === 'workspace') {
        close()
        try {
          await openWorkspaceFile({ ...file, path: result.path })
        } catch (error) {
          reportError(error)
        }
        return
      }
      previewTitle.textContent = basename(file.path)
      previewTitle.title = file.path
      previewContents.textContent = result.text
      previewLimit.hidden = !result.limited
      preview.hidden = false
      previewContents.focus({ preventScroll: true })
      const lineHeight = Number.parseFloat(getComputedStyle(previewContents).lineHeight)
      previewContents.scrollTop = file.line ? (file.line - 1) * lineHeight : 0
    } catch (error) {
      if (selection === current && request === fileRequest) {
        preview.hidden = false
        previewTitle.textContent = basename(file.path)
        previewLimit.hidden = true
        previewContents.textContent = reportError(error, { silent: true }).message
        previewContents.focus({ preventScroll: true })
      }
    }
  }

  function updateLatestButton() {
    latest.hidden = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 72
  }

  async function readThread(thread: AgentThread, preserveScroll = false) {
    const previousTop = conversation.scrollTop
    const atEnd = conversation.scrollHeight - previousTop - conversation.clientHeight < 72
    clearSelection()
    const current = crypto.randomUUID()
    selection = current
    reading = true
    updateTopbar()
    renderAgentThreadConversation(conversation, { provider: thread.provider, loading: true })
    updateLatestButton()
    try {
      const events = await api.read(thread.id, current)
      if (selection !== current) return
      const transcript = renderAgentThreadConversation(conversation, {
        provider: thread.provider,
        providerMark: providerMark(thread.provider),
        events,
        onOpenFile: (file, button) => void readFile(file, button),
      })
      conversation.scrollTop = preserveScroll ? (atEnd ? conversation.scrollHeight : previousTop) : 0
      minimap.setTranscript(transcript)
    } catch (error) {
      if (selection !== current) return
      reportError(error, { silent: true })
      renderAgentThreadConversation(conversation, {
        provider: thread.provider,
        error: 'Couldn’t read this conversation.',
        onRetry: requestRefresh,
      })
    } finally {
      if (selection === current) {
        reading = false
        updateTopbar()
        updateLatestButton()
      }
    }
  }

  function requestRefresh() {
    const operation = selected ? readThread(selected, true) : refreshList()
    void operation.catch((error: unknown) => reportError(error))
  }

  function openThread(thread: AgentThread) {
    previousListTop = list.scrollTop
    selected = thread
    browser.hidden = true
    detail.hidden = false
    detail.dataset.provider = thread.provider
    detailTitle.textContent = thread.title
    detailProvider.replaceChildren(
      providerMark(thread.provider),
      document.createTextNode(agentProviderNames[thread.provider]),
    )
    detailProject.textContent = projectName(projectOf(thread))
    detailProject.hidden = projectOf(thread) === NO_PROJECT
    detailCwd.textContent = thread.cwd
    detailCwd.title = thread.cwd
    detailCwd.hidden = !thread.cwd
    renderState(detailState, stateOf(thread))
    renderTime(detailTime, thread.updatedAt, lastChecked, true)
    void readThread(thread).catch((error: unknown) => reportError(error))
    detailTitle.focus({ preventScroll: true })
  }

  function backToThreads() {
    if (!selected) return
    const id = selected.id
    clearSelection()
    selected = undefined
    conversation.replaceChildren()
    detail.hidden = true
    browser.hidden = false
    list.scrollTop = previousListTop
    updateTopbar()
    ;(rowButtons.get(id) ?? roster).focus({ preventScroll: true })
  }

  async function refreshList() {
    if (host.hidden || listing) return
    listing = true
    sync.textContent = 'Reading local sessions…'
    sync.dataset.state = ''
    updateTopbar()
    if (!loaded) renderRoster()
    try {
      const result = await api.list()
      if (disposed) return
      unavailable = new Set(result.unavailable)
      const incoming = new Map(result.threads.map(thread => [thread.id, thread]))
      for (const [id, thread] of threads) {
        if (!incoming.has(id) && unavailable.has(thread.provider)) incoming.set(id, thread)
      }
      threads = incoming
      if (projectFilter && ![...threads.values()].some(thread => projectOf(thread) === projectFilter))
        projectFilter = ''
      loaded = true
      listError = false
      lastChecked = Date.now()
      sync.textContent = unavailable.size
        ? `${unavailable.size} ${unavailable.size === 1 ? 'source' : 'sources'} unavailable`
        : 'Local snapshot'
      sync.title = `Checked ${timeFormat.format(lastChecked)}`
      sync.dataset.state = unavailable.size ? 'warning' : ''
    } catch (error) {
      if (disposed) return
      listError = true
      sync.textContent = 'Refresh failed'
      sync.title = reportError(error, { silent: true }).message
      sync.dataset.state = 'warning'
    } finally {
      listing = false
      if (!disposed) {
        updateTopbar()
        renderRoster()
      }
    }
  }

  function close() {
    if (host.hidden) return
    const previous = returnFocus
    returnFocus = null
    host.hidden = true
    if (selected) {
      clearSelection()
      selected = undefined
      conversation.replaceChildren()
      detail.hidden = true
      browser.hidden = false
    }
    updateTopbar()
    onVisibilityChange?.(false)
    if (previous?.isConnected) previous.focus({ preventScroll: true })
  }

  requireElement(host, '[data-close]', HTMLButtonElement).addEventListener('click', close)
  sidebarToggle.addEventListener('click', () => {
    setProjectsOpen(!projectsOpen)
    if (projectsOpen) projectNav.querySelector<HTMLElement>('[aria-current="true"]')?.focus({ preventScroll: true })
  })
  back.addEventListener('click', backToThreads)
  refresh.addEventListener('click', requestRefresh)
  query.addEventListener('input', applyFilters)
  allAgents.addEventListener('click', () => {
    providerFilter = undefined
    applyFilters()
  })
  for (const [provider, { button }] of sources) {
    button.addEventListener('click', () => {
      providerFilter = providerFilter === provider ? undefined : provider
      applyFilters()
    })
  }
  running.addEventListener('click', () => {
    runningOnly = !runningOnly
    running.setAttribute('aria-pressed', String(runningOnly))
    applyFilters()
  })
  host.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (event.target === query && query.value) {
      event.preventDefault()
      query.value = ''
      applyFilters()
      return
    }
    event.preventDefault()
    if (!preview.hidden) closePreview()
    else if (selected) backToThreads()
    else close()
  })
  conversation.addEventListener('scroll', updateLatestButton, { passive: true })
  conversation.addEventListener('toggle', () => requestAnimationFrame(updateLatestButton), { capture: true })
  latest.addEventListener('click', () => {
    conversation.scrollTop = conversation.scrollHeight
    conversation.focus({ preventScroll: true })
  })
  const transcriptSize = new ResizeObserver(updateLatestButton)
  transcriptSize.observe(conversation)

  function closePreview() {
    fileRequest++
    preview.hidden = true
    previewContents.textContent = ''
    if (fileButton?.isConnected) fileButton.focus({ preventScroll: true })
    else detailTitle.focus({ preventScroll: true })
    fileButton = undefined
  }
  requireElement(preview, '[data-close-preview]', HTMLButtonElement).addEventListener('click', closePreview)

  setProjectsOpen(true)

  return {
    open() {
      if (!host.hidden || disposed) return
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      host.hidden = false
      updateTopbar()
      onVisibilityChange?.(true)
      roster.focus({ preventScroll: true })
      requestRefresh()
    },
    close,
    dispose() {
      close()
      disposed = true
      transcriptSize.disconnect()
      minimap.dispose()
    },
  }
}
